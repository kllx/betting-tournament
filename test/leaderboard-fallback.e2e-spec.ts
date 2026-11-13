import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Leaderboard PostgreSQL fallback", () => {
  let dataSource: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    redis = new Redis("redis://localhost:56379/8");
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at) VALUES
      ('alice', 100, '2026-11-12T10:01:00Z'),
      ('bob', 200, '2026-11-12T10:02:00Z')
    `);
  });

  afterAll(async () => {
    await redis.quit();
    await dataSource.destroy();
  });

  function createService(maxRequests = 100): LeaderboardService {
    jest
      .spyOn(redis, "zrevrange")
      .mockRejectedValue(new Error("Redis unavailable"));
    return new LeaderboardService(
      dataSource,
      redis,
      new ConfigService({
        rateLimit: {
          postgresFallbackWindowMs: 60000,
          postgresFallbackMaxRequests: maxRequests,
        },
      }),
    );
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reads a consistent leaderboard with one PostgreSQL statement", async () => {
    const service = createService();
    const query = jest.spyOn(dataSource, "query");

    await expect(service.getLeaderboard("alice")).resolves.toEqual({
      top: [
        { rank: 1, playerId: "bob", points: 200 },
        { rank: 2, playerId: "alice", points: 100 },
      ],
      player: { rank: 2, playerId: "alice", points: 100 },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects excess fallback traffic before running ranking SQL", async () => {
    const service = createService(2);

    await service.getLeaderboard("alice");
    await service.getLeaderboard("alice");
    const query = jest.spyOn(dataSource, "query");

    await expect(service.getLeaderboard("alice")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain("WITH ranked");
  });

  it("fails closed when the fallback limiter is unavailable", async () => {
    const service = createService();
    jest.spyOn(redis, "eval").mockRejectedValue(new Error("Redis unavailable"));
    const query = jest.spyOn(dataSource, "query");

    await expect(service.getLeaderboard("alice")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain("WITH ranked");
  });
});
