import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { StorageRetentionService } from "../src/database/retention.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Dedup registry retention", () => {
  let dataSource: DataSource;
  let retention: StorageRetentionService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
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

  it("archives old dedup ids and keeps recent ids active", async () => {
    await dataSource.query(`
      INSERT INTO bet_event_ids (event_id, received_at) VALUES
      ('old-event', now() - interval '91 days'),
      ('recent-event', now())
    `);

    await retention.runOnce();

    const active = await dataSource.query(
      "SELECT event_id FROM bet_event_ids ORDER BY event_id",
    );
    expect(active).toEqual([{ event_id: "recent-event" }]);
    const archived = await dataSource.query(
      "SELECT event_id FROM bet_event_ids_archive",
    );
    expect(archived).toEqual([{ event_id: "old-event" }]);
  });

  it("recognizes duplicates after their dedup id is archived", async () => {
    const processing = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1 }),
    );
    const event = {
      betId: "archived-bet",
      playerId: "archived-player",
      currency: "USD",
      stake: 1,
      winAmount: 10,
      settledAt: "2026-11-12T10:00:00.000Z",
    };
    await processing.process("bet.settled", event);
    await dataSource.query(
      "UPDATE bet_event_ids SET received_at = now() - interval '91 days'",
    );

    await retention.runOnce();
    const archived = await dataSource.query(
      "SELECT event_id FROM bet_event_ids_archive",
    );
    expect(archived).toEqual([{ event_id: "bet.settled:archived-bet" }]);
    const duplicate = await processing.process("bet.settled", event);

    expect(duplicate).toEqual({
      status: "duplicate",
      reason: "duplicate_event",
    });
    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = 'archived-player'",
    );
    expect(players).toEqual([{ points: 10 }]);
    await expect(
      processing.process("bet.settled", { ...event, winAmount: 999 }),
    ).rejects.toThrow("Event payload conflict");
  });

  it("deletes archive records after the archive retention window", async () => {
    await dataSource.query(`
      INSERT INTO bet_event_ids_archive (event_id, received_at) VALUES
      ('expired-archive', now() - interval '366 days'),
      ('recent-archive', now())
    `);

    await retention.runOnce();

    const archived = await dataSource.query(
      "SELECT event_id FROM bet_event_ids_archive ORDER BY event_id",
    );
    expect(archived).toEqual([{ event_id: "recent-archive" }]);
  });
});
