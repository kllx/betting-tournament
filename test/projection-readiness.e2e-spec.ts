import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardProjection } from "../src/leaderboard/leaderboard.projection";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import { ReconciliationLock } from "../src/leaderboard/reconciliation-lock";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Projection readiness", () => {
  let dataSource: DataSource;
  let redis: Redis;
  let projection: LeaderboardProjection;
  let service: LeaderboardService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    redis = new Redis("redis://localhost:56379/12");
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('winner', 100)",
    );
    projection = new LeaderboardProjection(redis, dataSource);
    service = new LeaderboardService(
      dataSource,
      redis,
      new ConfigService({
        rateLimit: {
          postgresFallbackWindowMs: 1000,
          postgresFallbackMaxRequests: 100,
        },
      }),
    );
  });

  afterAll(async () => {
    await redis.quit();
    await dataSource.destroy();
  });

  it("uses PostgreSQL when the live projection is not ready", async () => {
    await expect(service.getLeaderboard("winner")).resolves.toEqual({
      top: [{ rank: 1, playerId: "winner", points: 100 }],
      player: { rank: 1, playerId: "winner", points: 100 },
    });
  });

  it("rebuilds when readiness is lost and outbox is empty", async () => {
    await projection.reconcile();

    await expect(redis.get(LeaderboardProjection.readyKey)).resolves.toBe("1");
    await expect(service.getLeaderboard("winner")).resolves.toEqual({
      top: [{ rank: 1, playerId: "winner", points: 100 }],
      player: { rank: 1, playerId: "winner", points: 100 },
    });
  });

  it("waits for another owner to finish the rebuild", async () => {
    const lock = new ReconciliationLock(redis);
    await lock.acquire();
    const readiness = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await redis.set(LeaderboardProjection.readyKey, "1");
    })();

    await expect(projection.rebuild()).resolves.toBe(false);
    await expect(projection.waitUntilReady(500)).resolves.toBeUndefined();
    await readiness;
    await lock.release();
  });
});
