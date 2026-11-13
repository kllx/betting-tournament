import { Client } from "pg";
import { DataSource } from "typeorm";
import { BetEntity } from "../src/database/entities/bet.entity";
import { PlayerEntity } from "../src/database/entities/player.entity";
import { SecurityHardening } from "../src/database/migrations/AddEventSecurity";
import { TournamentFinalization } from "../src/database/migrations/AddPayoutLedger";
import { ReviewHardening } from "../src/database/migrations/AddScoreRevisions";
import { StorageRetention } from "../src/database/migrations/AddStorageRetention";
import { ArchiveRetention } from "../src/database/migrations/AddArchiveRetention";
import { DedupRetention } from "../src/database/migrations/AddDedupRetention";
import { TournamentState } from "../src/database/migrations/AddTournamentLifecycle";
import { InitialSchema } from "../src/database/migrations/CreateBettingSchema";
import { OptimizeHotPaths } from "../src/database/migrations/OptimizeHotPaths";

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:55432/betting_tournament_test";

async function createTestDatabase(): Promise<void> {
  const url = new URL(testDatabaseUrl);
  const databaseName = url.pathname.slice(1);
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      "TEST_DATABASE_URL must point to a database ending in _test",
    );
  }

  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await client.end();
  }
}

export async function createTestDataSource(): Promise<DataSource> {
  await createTestDatabase();
  const dataSource = new DataSource({
    type: "postgres",
    url: testDatabaseUrl,
    entities: [BetEntity, PlayerEntity],
    migrations: [
      InitialSchema,
      TournamentState,
      TournamentFinalization,
      SecurityHardening,
      ReviewHardening,
      StorageRetention,
      OptimizeHotPaths,
      DedupRetention,
      ArchiveRetention,
    ],
  });
  dataSource.setOptions({ migrationsTransactionMode: "each" });
  await dataSource.initialize();
  await dataSource.runMigrations();
  await resetTestDataSource(dataSource);
  return dataSource;
}

export async function resetTestDataSource(
  dataSource: DataSource,
): Promise<void> {
  await dataSource.query(
    "TRUNCATE TABLE bet_events, bet_event_ids, bet_event_ids_archive, bets, players, tournament_state, tournament_winners, payouts, outbox, leaderboard_snapshots",
  );
  await dataSource.query(`
    INSERT INTO tournament_state (
      id, phase, ends_at, settlement_cutoff_at, finalize_at
    ) VALUES (
      1,
      'ACTIVE',
      now() + interval '100 years',
      now() + interval '100 years' + interval '10 minutes',
      now() + interval '100 years' + interval '15 minutes'
    )
  `);
}
