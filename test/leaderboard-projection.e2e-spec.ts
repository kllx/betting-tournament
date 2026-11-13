import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardProjection } from "../src/leaderboard/leaderboard.projection";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Redis leaderboard projection", () => {
  let dataSource: DataSource;
  let redis: Redis;
  let projection: LeaderboardProjection;
  let leaderboard: LeaderboardService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    redis = new Redis("redis://localhost:56379/6");
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
    await redis.set(LeaderboardProjection.readyKey, "1");
    projection = new LeaderboardProjection(redis, dataSource);
    leaderboard = new LeaderboardService(dataSource, redis);
  });

  afterAll(async () => {
    await redis.quit();
    await dataSource.destroy();
  });

  it("ranks equal points by the earliest result achievement", async () => {
    await projection.apply({
      playerId: "alice",
      points: 100,
      pointsReachedAt: "2026-11-12T10:01:00.000Z",
    });
    await projection.apply({
      playerId: "bob",
      points: 100,
      pointsReachedAt: "2026-11-12T10:02:00.000Z",
    });
    await projection.apply({
      playerId: "carol",
      points: 150,
      pointsReachedAt: "2026-11-12T10:03:00.000Z",
    });

    const result = await leaderboard.getLeaderboard("bob");
    expect(result.top).toEqual([
      { rank: 1, playerId: "carol", points: 150 },
      { rank: 2, playerId: "alice", points: 100 },
      { rank: 3, playerId: "bob", points: 100 },
    ]);
    expect(result.player?.rank).toBe(3);
  });

  it("does not change the tie-break after a zero-point settlement", async () => {
    await projection.apply({
      playerId: "alice",
      points: 100,
      pointsReachedAt: "2026-11-12T10:01:00.000Z",
      scoreVersion: "1",
    });
    await projection.apply({
      playerId: "bob",
      points: 100,
      pointsReachedAt: "2026-11-12T10:02:00.000Z",
      scoreVersion: "2",
    });
    await projection.apply({
      playerId: "alice",
      points: 100,
      pointsReachedAt: "2026-11-12T10:01:00.000Z",
      scoreVersion: "3",
    });

    const result = await leaderboard.getLeaderboard("alice");
    expect(result.top.map((entry) => entry.playerId)).toEqual(["alice", "bob"]);
  });

  it("does not let a stale projection event overwrite a newer score", async () => {
    await projection.apply({
      playerId: "alice",
      points: 100,
      pointsReachedAt: "2026-11-12T10:02:00.000Z",
    });
    await projection.apply({
      playerId: "alice",
      points: 50,
      pointsReachedAt: "2026-11-12T10:01:00.000Z",
    });

    const result = await leaderboard.getLeaderboard("alice");
    expect(result.player).toEqual({ rank: 1, playerId: "alice", points: 100 });
  });

  it("rebuilds the projection from PostgreSQL", async () => {
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at) VALUES
      ('alice', 100, '2026-11-12T10:01:00Z'),
      ('bob', 200, '2026-11-12T10:02:00Z')
    `);

    await projection.rebuild();

    const result = await leaderboard.getLeaderboard("alice");
    expect(result.top).toEqual([
      { rank: 1, playerId: "bob", points: 200 },
      { rank: 2, playerId: "alice", points: 100 },
    ]);
  });

  it("incrementally reconciles only new outbox events", async () => {
    await dataSource.query(
      `INSERT INTO players (player_id, points, points_reached_at)
       VALUES ('alice', 100, now())`,
    );
    await projection.rebuild();
    await dataSource.query(
      `INSERT INTO players (player_id, points, points_reached_at)
       VALUES ('bob', 200, now())`,
    );
    await dataSource.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ($1, $2, $3)`,
      [
        "score:bob",
        "player.score.changed",
        JSON.stringify({
          playerId: "bob",
          points: 200,
          pointsReachedAt: "2026-11-12T10:02:00.000Z",
          scoreVersion: "2",
        }),
      ],
    );

    await projection.reconcile();

    const result = await leaderboard.getLeaderboard("bob");
    expect(result.player).toEqual({ rank: 1, playerId: "bob", points: 200 });
  });

  it("replaces a non-empty live projection with an empty rebuilt projection", async () => {
    await projection.apply({
      playerId: "stale",
      points: 100,
      pointsReachedAt: "2026-11-12T10:00:00.000Z",
    });

    await projection.rebuild();

    await expect(leaderboard.getLeaderboard("stale")).resolves.toEqual({
      top: [],
      player: null,
    });
  });

  it("exposes only a complete old or new projection during rebuild", async () => {
    await projection.apply({
      playerId: "old",
      points: 1,
      pointsReachedAt: "2026-11-12T10:00:00.000Z",
    });
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at)
      SELECT 'player-' || g, g, now() FROM generate_series(1, 6000) AS g
    `);

    const rebuilding = projection.rebuild();
    let complete = false;
    while (!complete) {
      const [count, oldMember] = await Promise.all([
        redis.zcard(LeaderboardProjection.playersKey),
        redis.hget(LeaderboardProjection.membersKey, "old"),
      ]);
      const oldProjection = count === 1 && oldMember !== null;
      const newProjection = count === 6000 && oldMember === null;
      expect(oldProjection || newProjection).toBe(true);
      let settled = false;
      await Promise.race([
        rebuilding.then(() => {
          settled = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 1)),
      ]);
      complete = settled;
    }
    await rebuilding;
  });
});
