import { Client } from "pg";
import { DataSource } from "typeorm";
import { BetEntity } from "../src/database/entities/bet.entity";
import { PlayerEntity } from "../src/database/entities/player.entity";
import { fingerprintLegacyBet } from "../src/database/legacy-fingerprint";
import { SecurityHardening } from "../src/database/migrations/AddEventSecurity";
import { TournamentFinalization } from "../src/database/migrations/AddPayoutLedger";
import { ReviewHardening } from "../src/database/migrations/AddScoreRevisions";
import {
  cutoverBetEvents,
  StorageRetention,
} from "../src/database/migrations/AddStorageRetention";
import { TournamentState } from "../src/database/migrations/AddTournamentLifecycle";
import { InitialSchema } from "../src/database/migrations/CreateBettingSchema";
import { testDatabaseUrl } from "./test-database";

const databaseName = `betting_migrations_${process.pid}_test`;
const databaseUrl = new URL(testDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const legacyMigrations = [
  InitialSchema,
  TournamentState,
  TournamentFinalization,
  SecurityHardening,
];

async function createDatabase(): Promise<void> {
  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(): Promise<void> {
  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await client.end();
  }
}

function createDataSource(migrations: any[]): DataSource {
  const dataSource = new DataSource({
    type: "postgres",
    url: databaseUrl.toString(),
    entities: [BetEntity, PlayerEntity],
    migrations,
  });
  dataSource.setOptions({ migrationsTransactionMode: "each" });
  return dataSource;
}

describe("Schema migrations", () => {
  beforeEach(async () => {
    await createDatabase();
    const dataSource = createDataSource(legacyMigrations);
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  afterEach(async () => {
    await dropDatabase();
  });

  it("backfills fingerprints only from processed settlements", async () => {
    const dataSource = createDataSource([ReviewHardening]);
    await dataSource.initialize();
    const processedPayload = {
      betId: "legacy-bet",
      playerId: "legacy-player",
      currency: "USD",
      stake: 1,
      winAmount: 10,
      settledAt: "2026-11-12T10:00:00.000+03:00",
    };
    await dataSource.query(
      `INSERT INTO bets (
        bet_id, player_id, currency, stake, win_amount, settled_at, points, status
      ) VALUES ('legacy-bet', 'legacy-player', 'USD', 1, 10, '2026-11-12T07:00:00Z', 10, 'settled')`,
    );
    await dataSource.query(
      `INSERT INTO bet_events (event_id, bet_id, event_type, payload, status) VALUES
       ('processed-event', 'legacy-bet', 'bet.settled', $1, 'processed'),
       ('ignored-event', 'legacy-bet', 'bet.settled', $2, 'ignored')`,
      [
        JSON.stringify(processedPayload),
        JSON.stringify({ ...processedPayload, winAmount: 999 }),
      ],
    );

    await dataSource.runMigrations();

    const bets = await dataSource.query(
      "SELECT payload_hash FROM bets WHERE bet_id = 'legacy-bet'",
    );
    expect(bets).toEqual([
      { payload_hash: fingerprintLegacyBet(processedPayload) },
    ]);
    await dataSource.destroy();
  });

  it("rolls back without narrowing columns below existing identifiers", async () => {
    const dataSource = createDataSource([...legacyMigrations, ReviewHardening]);
    await dataSource.initialize();
    await dataSource.runMigrations();
    await dataSource.query(
      `INSERT INTO bet_events (event_id, bet_id, event_type, payload, status)
       VALUES ($1, 'bet', 'bet.settled', '{}', 'processed')`,
      ["e".repeat(200)],
    );
    await dataSource.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ($1, 'player.score.changed', '{}')`,
      ["o".repeat(280)],
    );

    await expect(dataSource.undoLastMigration()).resolves.not.toThrow();
    await expect(dataSource.undoLastMigration()).resolves.not.toThrow();
    await dataSource.destroy();
  });

  it("backfills and replicates writes during online partitioning", async () => {
    const dataSource = createDataSource([StorageRetention]);
    dataSource.setOptions({ migrationsTransactionMode: "each" });
    await dataSource.initialize();
    await dataSource.query(`
      INSERT INTO bet_events (event_id, bet_id, event_type, payload, status)
      SELECT 'event-' || g, 'bet-' || g, 'bet.settled', '{}', 'processed'
      FROM generate_series(1, 5000) AS g
    `);

    const migrating = dataSource.runMigrations();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await dataSource.query(
      "INSERT INTO bet_event_ids (event_id, received_at) VALUES ('live-event', now())",
    );
    await dataSource.query(`
      INSERT INTO bet_events (event_id, bet_id, event_type, payload, status)
      VALUES ('live-event', 'live-bet', 'bet.settled', '{}', 'processed')
    `);
    await migrating;

    const counts = await dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM bet_events) AS events,
        (SELECT count(*)::int FROM bet_event_ids) AS ids,
        (SELECT relkind FROM pg_class WHERE oid = 'bet_events'::regclass) AS relkind
    `);
    expect(counts).toEqual([{ events: 5001, ids: 5001, relkind: "p" }]);
    const live = await dataSource.query(
      "SELECT event_id FROM bet_events WHERE event_id = 'live-event'",
    );
    expect(live).toEqual([{ event_id: "live-event" }]);
    await dataSource.destroy();
  });

  it("defers cutover until the backfill is marked complete", async () => {
    process.env.BET_EVENTS_DEFER_CUTOVER = "true";
    const dataSource = createDataSource([StorageRetention]);
    dataSource.setOptions({ migrationsTransactionMode: "each" });
    await dataSource.initialize();
    try {
      await dataSource.query(`
        INSERT INTO bet_events (event_id, bet_id, event_type, payload, status)
        SELECT 'event-' || g, 'bet-' || g, 'bet.settled', '{}', 'processed'
        FROM generate_series(1, 100) AS g
      `);
      await dataSource.runMigrations();

      const before = await dataSource.query(`
        SELECT
          (SELECT relkind FROM pg_class WHERE oid = 'bet_events'::regclass) AS current_kind,
          (SELECT relkind FROM pg_class WHERE oid = 'bet_events_new'::regclass) AS new_kind
      `);
      expect(before).toEqual([{ current_kind: "r", new_kind: "p" }]);

      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await cutoverBetEvents(queryRunner);
      await queryRunner.release();

      const after = await dataSource.query(`
        SELECT
          (SELECT relkind FROM pg_class WHERE oid = 'bet_events'::regclass) AS current_kind,
          to_regclass('bet_events_new') AS new_table,
          (SELECT count(*)::int FROM bet_events) AS events
      `);
      expect(after).toEqual([
        { current_kind: "p", new_table: null, events: 100 },
      ]);
    } finally {
      delete process.env.BET_EVENTS_DEFER_CUTOVER;
      await dataSource.destroy();
    }
  });
});
