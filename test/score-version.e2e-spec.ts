import Redis from "ioredis";
import { DataSource } from "typeorm";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { LeaderboardProjection } from "../src/leaderboard/leaderboard.projection";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Score revision ordering", () => {
  let dataSource: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    redis = new Redis("redis://localhost:56379/6");
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
    await redis.set(LeaderboardProjection.readyKey, "1");
  });

  afterAll(async () => {
    await redis.quit();
    await dataSource.destroy();
  });

  it("keeps the final version maximal and restores the final score in reverse delivery", async () => {
    const service = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1 }),
    );
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.process("bet.settled", {
          betId: `version-bet-${index}`,
          playerId: "version-player",
          currency: "USD",
          stake: 1,
          winAmount: 1,
          settledAt: "2026-11-12T10:00:00.000Z",
        }),
      ),
    );

    const [player] = await dataSource.query(
      "SELECT points, score_version FROM players WHERE player_id = 'version-player'",
    );
    const records = await dataSource.query(
      "SELECT payload FROM outbox WHERE event_type = 'player.score.changed'",
    );
    const maxVersion = records.reduce(
      (max: number, row: any) =>
        Math.max(max, Number(row.payload.scoreVersion)),
      0,
    );
    expect(player.points).toBe(20);
    expect(Number(player.score_version)).toBe(maxVersion);

    const projection = new LeaderboardProjection(redis, dataSource);
    records.sort(
      (a: any, b: any) =>
        Number(b.payload.scoreVersion) - Number(a.payload.scoreVersion),
    );
    for (const record of records) {
      await projection.apply(record.payload);
    }
    const leaderboard = await new LeaderboardService(
      dataSource,
      redis,
    ).getLeaderboard("version-player");
    expect(leaderboard.player).toEqual({
      rank: 1,
      playerId: "version-player",
      points: 20,
    });
  });
});
