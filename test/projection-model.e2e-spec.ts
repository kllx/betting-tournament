import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardConsumer } from "../src/leaderboard/leaderboard.consumer";
import {
  LeaderboardProjection,
  ScoreProjection,
} from "../src/leaderboard/leaderboard.projection";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import { createTestDataSource, resetTestDataSource } from "./test-database";

interface ExpectedPlayer {
  playerId: string;
  points: number;
  timestamp: number;
}

describe("Projection model invariants", () => {
  let dataSource: DataSource;
  let redis: Redis;
  let projection: LeaderboardProjection;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    redis = new Redis("redis://localhost:56379/9");
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
    await redis.set(LeaderboardProjection.readyKey, "1");
    projection = new LeaderboardProjection(redis, dataSource);
  });

  afterAll(async () => {
    await redis.quit();
    await dataSource.destroy();
  });

  it("matches an independent ranking model after shuffled and stale deliveries", async () => {
    const expected: ExpectedPlayer[] = [];
    const events: ScoreProjection[] = [];
    const base = Date.parse("2026-11-12T10:00:00.000Z");
    for (let index = 0; index < 200; index += 1) {
      const playerId = `player-${String(index).padStart(3, "0")}`;
      const points = (index % 7) * 10;
      const timestamp = base + (index % 1000);
      expected.push({ playerId, points, timestamp });
      events.push({
        playerId,
        points,
        pointsReachedAt: new Date(timestamp).toISOString(),
        pointsReachedAtUs: String(timestamp * 1000),
        scoreVersion: String(index + 1),
      });
      events.push({
        playerId,
        points: 0,
        pointsReachedAt: new Date(base).toISOString(),
        pointsReachedAtUs: String(base * 1000),
        scoreVersion: String(index),
      });
    }
    let seed = 42;
    for (let index = events.length - 1; index > 0; index -= 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const other = seed % (index + 1);
      [events[index], events[other]] = [events[other], events[index]];
    }
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at, score_version)
      SELECT
        'player-' || LPAD(g::text, 3, '0'),
        (g % 7) * 10,
        '2026-11-12T10:00:00Z'::timestamptz + (g % 1000) * interval '1 millisecond',
        g + 1
      FROM generate_series(0, 199) AS g
    `);
    for (const event of events) {
      await projection.apply(event);
    }

    expected.sort(
      (left, right) =>
        right.points - left.points ||
        left.timestamp - right.timestamp ||
        right.playerId.localeCompare(left.playerId),
    );
    const expectedTop = expected.slice(0, 100).map((entry, index) => ({
      rank: index + 1,
      playerId: entry.playerId,
      points: entry.points,
    }));
    const leaderboard = new LeaderboardService(dataSource, redis);
    const requested = expected[150];

    await expect(
      leaderboard.getLeaderboard(requested.playerId),
    ).resolves.toEqual({
      top: expectedTop,
      player: {
        rank: 151,
        playerId: requested.playerId,
        points: requested.points,
      },
    });

    await projection.rebuild();
    await expect(
      leaderboard.getLeaderboard(requested.playerId),
    ).resolves.toEqual({
      top: expectedTop,
      player: {
        rank: 151,
        playerId: requested.playerId,
        points: requested.points,
      },
    });
  });

  it("rejects invalid microsecond timestamps before writing to Redis", async () => {
    const consumer = new LeaderboardConsumer(
      new ConfigService({
        security: {
          internalSigningSecret: "test-internal-secret-32-characters",
        },
      }),
      projection,
    );

    await expect(
      (consumer as any).process({
        playerId: "player-1",
        points: 10,
        pointsReachedAt: "2026-11-12T10:00:00.000Z",
        pointsReachedAtUs: "not-a-number",
        scoreVersion: "1",
      }),
    ).rejects.toThrow(SyntaxError);
  });
});
