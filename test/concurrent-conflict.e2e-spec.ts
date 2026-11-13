import { DataSource } from "typeorm";
import { BetEvent } from "../src/bets/bet-event";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Concurrent bet payload conflicts", () => {
  let dataSource: DataSource;
  let service: BetProcessingService;

  const original: BetEvent = {
    betId: "race-bet",
    playerId: "original-player",
    currency: "USD",
    stake: 1,
    winAmount: 100,
    settledAt: "2026-11-12T10:00:00.000Z",
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    service = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1 }),
    );
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("rejects a conflicting rollback even when it races the original settlement", async () => {
    for (let index = 0; index < 20; index += 1) {
      const betId = `race-bet-${index}`;
      const results = await Promise.allSettled([
        service.process(
          "bet.settled",
          { ...original, betId },
          `settle-${index}`,
        ),
        service.process(
          "bet.rollback",
          { ...original, betId, playerId: "attacker" },
          `rollback-${index}`,
        ),
      ]);

      expect(results.some((result) => result.status === "rejected")).toBe(true);
      await resetTestDataSource(dataSource);
    }
  });
});
