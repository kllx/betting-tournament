import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { StorageRetentionService } from "../src/database/retention.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Storage retention", () => {
  let dataSource: DataSource;
  let retention: StorageRetentionService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    const today = new Date().toISOString().slice(0, 10);
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS bet_events_before_today PARTITION OF bet_events
      FOR VALUES FROM (MINVALUE) TO ('${today}')
    `);
    retention = new StorageRetentionService(
      dataSource,
      new ConfigService({
        retention: {
          outboxDays: 7,
          betEventsDays: 30,
          betEventIdsDays: 90,
          betEventIdsArchiveDays: 365,
          batchSize: 2,
        },
      }),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("deletes old published outbox records in batches", async () => {
    await dataSource.query(`
      INSERT INTO outbox (event_id, event_type, payload, status, published_at) VALUES
      ('old-1', 'player.score.changed', '{}', 'PUBLISHED', now() - interval '8 days'),
      ('old-2', 'player.score.changed', '{}', 'PUBLISHED', now() - interval '8 days'),
      ('old-3', 'player.score.changed', '{}', 'PUBLISHED', now() - interval '8 days'),
      ('recent', 'player.score.changed', '{}', 'PUBLISHED', now()),
      ('pending', 'player.score.changed', '{}', 'NEW', NULL),
      ('failed', 'player.score.changed', '{}', 'FAILED', now() - interval '8 days')
    `);

    await retention.runOnce();

    const records = await dataSource.query(
      "SELECT event_id FROM outbox ORDER BY event_id",
    );
    expect(records).toEqual([
      { event_id: "failed" },
      { event_id: "pending" },
      { event_id: "recent" },
    ]);
  });

  it("keeps event idempotency across received-at partitions", async () => {
    const processing = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1 }),
    );
    const event = {
      betId: "partition-bet",
      playerId: "partition-player",
      currency: "USD",
      stake: 1,
      winAmount: 10,
      settledAt: "2026-11-12T10:00:00.000Z",
    };
    await processing.process("bet.settled", event);
    await dataSource.query(`
      UPDATE bet_events SET received_at = received_at - interval '2 days'
      WHERE event_id = 'bet.settled:partition-bet'
    `);
    await dataSource.query(`
      UPDATE bet_event_ids SET received_at = received_at - interval '2 days'
      WHERE event_id = 'bet.settled:partition-bet'
    `);

    const duplicate = await processing.process("bet.settled", event);

    expect(duplicate).toEqual({
      status: "duplicate",
      reason: "duplicate_event",
    });
    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = 'partition-player'",
    );
    expect(players).toEqual([{ points: 10 }]);
    const partitions = await dataSource.query(`
      SELECT count(*)::int AS count FROM pg_inherits
      WHERE inhparent = 'bet_events'::regclass
    `);
    expect(partitions[0].count).toBeGreaterThanOrEqual(3);
  });

  it("validates duplicates using the registry after payload retention", async () => {
    const processing = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1 }),
    );
    const event = {
      betId: "retained-bet",
      playerId: "retained-player",
      currency: "USD",
      stake: 1,
      winAmount: 10,
      settledAt: "2026-11-12T10:00:00.000Z",
    };
    await processing.process("bet.settled", event);
    await dataSource.query(
      "DELETE FROM bet_events WHERE event_id = 'bet.settled:retained-bet'",
    );

    await expect(processing.process("bet.settled", event)).resolves.toEqual({
      status: "duplicate",
      reason: "duplicate_event",
    });
    await expect(
      processing.process("bet.settled", { ...event, winAmount: 999 }),
    ).rejects.toThrow("Event payload conflict");
  });

  it("drops expired event partitions without dropping the dedup registry", async () => {
    await dataSource.query(
      "INSERT INTO bet_event_ids (event_id, received_at) VALUES ('persistent-event', now())",
    );

    retention = new StorageRetentionService(
      dataSource,
      new ConfigService({
        retention: {
          outboxDays: 7,
          betEventsDays: 0,
          betEventIdsDays: 90,
          betEventIdsArchiveDays: 365,
          batchSize: 2,
        },
      }),
    );
    await retention.runOnce();

    const partitions = await dataSource.query(
      "SELECT to_regclass('bet_events_before_today') AS name",
    );
    expect(partitions).toEqual([{ name: null }]);
    const registry = await dataSource.query(
      "SELECT event_id FROM bet_event_ids WHERE event_id = 'persistent-event'",
    );
    expect(registry).toEqual([{ event_id: "persistent-event" }]);
  });

  it("creates current and next day partitions idempotently", async () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const name = (date: Date) =>
      `bet_events_${date.toISOString().slice(0, 10).replaceAll("-", "_")}`;

    await retention.runOnce();
    await retention.runOnce();

    const partitions = await dataSource.query(`
      SELECT child.relname AS name FROM pg_inherits
      JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
      WHERE pg_inherits.inhparent = 'bet_events'::regclass
    `);
    expect(partitions).toEqual(
      expect.arrayContaining([{ name: name(today) }, { name: name(tomorrow) }]),
    );
  });

  it("serializes concurrent partition maintenance across workers", async () => {
    retention = new StorageRetentionService(
      dataSource,
      new ConfigService({
        retention: {
          outboxDays: 7,
          betEventsDays: 0,
          betEventIdsDays: 90,
          betEventIdsArchiveDays: 365,
          batchSize: 100,
        },
      }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => retention.runOnce()),
    );

    expect(results.filter((result) => result.status === "rejected")).toEqual(
      [],
    );
  });

  it("keeps only indexes used by current hot paths", async () => {
    const indexes = await dataSource.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('idx_players_score_version', 'idx_outbox_published_retention')
    `);
    const scoreIndex = indexes.find(
      (row: any) => row.indexname === "idx_players_score_version",
    );
    const retentionIndex = indexes.find(
      (row: any) => row.indexname === "idx_outbox_published_retention",
    );

    expect(scoreIndex).toBeUndefined();
    expect(retentionIndex.indexdef).toContain("(published_at, id)");
  });
});
