import { DataSource } from "typeorm";
import { BetEvent } from "../src/bets/bet-event";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Tournament event time rules", () => {
  let dataSource: DataSource;
  let service: BetProcessingService;

  const event: BetEvent = {
    betId: "timed-bet-1",
    playerId: "timed-player-1",
    currency: "EUR",
    stake: 10,
    winAmount: 25.5,
    settledAt: "2026-11-12T10:00:00.000Z",
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    service = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1, EUR: 1.1 }),
    );
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("accepts a settlement during the ten minute grace period", async () => {
    await dataSource.query(`
      UPDATE tournament_state SET
        ends_at = now() - interval '5 minutes',
        settlement_cutoff_at = now() + interval '5 minutes',
        finalize_at = now() + interval '10 minutes'
    `);

    await service.process("bet.settled", event);

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 28 }]);
  });

  it("ignores a settlement after the grace period", async () => {
    await dataSource.query(`
      UPDATE tournament_state SET
        ends_at = now() - interval '20 minutes',
        settlement_cutoff_at = now() - interval '10 minutes',
        finalize_at = now() + interval '10 minutes'
    `);

    await service.process("bet.settled", event);

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([]);
  });

  it("ignores a rollback received after the tournament ends", async () => {
    await service.process("bet.settled", event);
    await dataSource.query(`
      UPDATE tournament_state SET
        ends_at = now() - interval '1 minute',
        settlement_cutoff_at = now() + interval '9 minutes',
        finalize_at = now() + interval '14 minutes'
    `);

    await service.process("bet.rollback", event);

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    const bets = await dataSource.query(
      "SELECT status FROM bets WHERE bet_id = $1",
      [event.betId],
    );
    expect(players).toEqual([{ points: 28 }]);
    expect(bets).toEqual([{ status: "settled" }]);
  });

  it("atomically writes score changes to the outbox", async () => {
    await service.process("bet.settled", event);
    await service.process("bet.rollback", event);

    const records = await dataSource.query(
      "SELECT event_type, payload FROM outbox ORDER BY id",
    );
    expect(records).toHaveLength(2);
    expect(records[0].event_type).toBe("player.score.changed");
    expect(records[0].payload).toMatchObject({
      playerId: event.playerId,
      points: 28,
    });
    expect(records[1].payload).toMatchObject({
      playerId: event.playerId,
      points: 0,
    });
  });
});
