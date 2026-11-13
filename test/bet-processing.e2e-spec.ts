import { DataSource } from "typeorm";
import { BetEvent } from "../src/bets/bet-event";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("BetProcessingService", () => {
  let dataSource: DataSource;
  let service: BetProcessingService;

  const event: BetEvent = {
    betId: "bet-1",
    playerId: "player-1",
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
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("adds converted points for a settled bet", async () => {
    await service.process("bet.settled", event);

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 28 }]);
  });

  it("counts concurrent deliveries of the same settled bet once", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => service.process("bet.settled", event)),
    );

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 28 }]);
  });

  it("removes points when a settled bet is rolled back", async () => {
    await service.process("bet.settled", event);
    await service.process("bet.rollback", event);

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 0 }]);
  });

  it("ignores a settlement that arrives after its rollback", async () => {
    await service.process("bet.rollback", event);
    await service.process("bet.settled", event);

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    const bets = await dataSource.query(
      "SELECT status FROM bets WHERE bet_id = $1",
      [event.betId],
    );
    expect(players).toEqual([]);
    expect(bets).toEqual([{ status: "rolled_back" }]);
  });

  it("applies concurrent rollbacks of one bet at most once", async () => {
    await service.process("bet.settled", event);
    await Promise.all(
      Array.from({ length: 5 }, () => service.process("bet.rollback", event)),
    );

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 0 }]);
  });

  it("uses the originally awarded points when rates change before rollback", async () => {
    await service.process("bet.settled", event);
    const serviceWithNewRates = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1, EUR: 2 }),
    );
    await serviceWithNewRates.process("bet.rollback", event);

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 0 }]);
  });

  it("marks the inbox processed with PostgreSQL microsecond timestamps", async () => {
    await service.process("bet.settled", event);

    const events = await dataSource.query(
      "SELECT status, processed_at FROM bet_events WHERE event_id = $1",
      ["bet.settled:bet-1"],
    );
    expect(events).toEqual([
      { status: "processed", processed_at: expect.any(Date) },
    ]);
  });
});
