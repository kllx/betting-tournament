import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardProjection } from "../src/leaderboard/leaderboard.projection";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import { ReconciliationLock } from "../src/leaderboard/reconciliation-lock";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Projection recovery ordering", () => {
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

  it("reconciles all committed outbox records even when commits complete out of order", async () => {
    const first = dataSource.createQueryRunner();
    await first.connect();
    await first.startTransaction();
    await first.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ('score:first', 'player.score.changed', $1)`,
      [
        JSON.stringify({
          playerId: "first",
          points: 10,
          pointsReachedAt: "2026-11-12T10:00:00.000Z",
          pointsReachedAtUs: "1763000000000000",
          scoreVersion: "100",
        }),
      ],
    );

    const second = dataSource.createQueryRunner();
    await second.connect();
    await second.startTransaction();
    await second.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ('score:second', 'player.score.changed', $1)`,
      [
        JSON.stringify({
          playerId: "second",
          points: 20,
          pointsReachedAt: "2026-11-12T10:01:00.000Z",
          pointsReachedAtUs: "1763000000000001",
          scoreVersion: "101",
        }),
      ],
    );
    await second.commitTransaction();
    await second.release();
    await first.commitTransaction();
    await first.release();

    await projection.reconcile();

    const result = await leaderboard.getLeaderboard("first");
    expect(result.top).toEqual([
      { rank: 1, playerId: "second", points: 20 },
      { rank: 2, playerId: "first", points: 10 },
    ]);
    expect(result.player?.rank).toBe(2);
  });

  it("resumes from the last cursor after rejecting a corrupt outbox event", async () => {
    await redis.set(LeaderboardProjection.lastOutboxIdKey, "0");
    await dataSource.query(
      `INSERT INTO outbox (event_id, event_type, payload) VALUES
       ('score:valid', 'player.score.changed', $1),
       ('score:corrupt', 'player.score.changed', $2)`,
      [
        JSON.stringify({
          playerId: "valid",
          points: 10,
          pointsReachedAt: "2026-11-12T10:00:00.000Z",
          scoreVersion: "1",
        }),
        JSON.stringify({
          playerId: "corrupt",
          points: 20,
          pointsReachedAt: "invalid",
          scoreVersion: "2",
        }),
      ],
    );

    await expect(projection.reconcile()).rejects.toThrow();
    await expect(
      redis.get(LeaderboardProjection.lastOutboxIdKey),
    ).resolves.toBe("0");

    await dataSource.query(
      "DELETE FROM outbox WHERE event_id = 'score:corrupt'",
    );
    await dataSource.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ('score:next', 'player.score.changed', $1)`,
      [
        JSON.stringify({
          playerId: "next",
          points: 30,
          pointsReachedAt: "2026-11-12T10:01:00.000Z",
          scoreVersion: "3",
        }),
      ],
    );
    await projection.reconcile();

    const cursor = await dataSource.query(
      "SELECT MAX(id)::text AS id FROM outbox",
    );
    await expect(
      redis.get(LeaderboardProjection.lastOutboxIdKey),
    ).resolves.toBe(cursor[0].id);
    const result = await leaderboard.getLeaderboard("valid");
    expect(result.top).toEqual([
      { rank: 1, playerId: "next", points: 30 },
      { rank: 2, playerId: "valid", points: 10 },
    ]);
  });

  it("keeps the live projection unchanged when another worker owns the lock", async () => {
    await projection.apply({
      playerId: "live",
      points: 10,
      pointsReachedAt: "2026-11-12T10:00:00.000Z",
    });
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('database', 20)",
    );
    const lock = new ReconciliationLock(redis);
    await lock.acquire();

    await projection.rebuild();

    await expect(leaderboard.getLeaderboard("live")).resolves.toEqual({
      top: [{ rank: 1, playerId: "live", points: 10 }],
      player: { rank: 1, playerId: "live", points: 10 },
    });
    await lock.release();
  });

  it("rejects a stale owner during the atomic swap and preserves live keys", async () => {
    await projection.apply({
      playerId: "live",
      points: 10,
      pointsReachedAt: "2026-11-12T10:00:00.000Z",
    });
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('database', 20)",
    );
    const evaluate = redis.eval.bind(redis);
    jest.spyOn(redis, "eval").mockImplementation(async (...args) => {
      if (args.includes(LeaderboardProjection.lastOutboxIdKey)) {
        await redis.set(ReconciliationLock.key, "new-owner", "PX", 30000);
      }
      return evaluate(...args);
    });

    try {
      await expect(projection.rebuild()).rejects.toThrow(
        "Reconciliation lock lost",
      );
      await expect(leaderboard.getLeaderboard("live")).resolves.toEqual({
        top: [{ rank: 1, playerId: "live", points: 10 }],
        player: { rank: 1, playerId: "live", points: 10 },
      });
    } finally {
      jest.restoreAllMocks();
    }
  });

  it("rebuilds from a consistent snapshot without waiting for a bet lock", async () => {
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('database', 20)",
    );
    const blocker = dataSource.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query(
      "SELECT id FROM tournament_state WHERE id = 1 FOR SHARE",
    );
    const rebuilding = projection.rebuild();
    let timeout: NodeJS.Timeout | undefined;

    try {
      await expect(
        Promise.race([
          rebuilding,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Rebuild waited for the bet lock")),
              500,
            );
          }),
        ]),
      ).resolves.toBe(true);
    } finally {
      clearTimeout(timeout);
      await blocker.rollbackTransaction();
      await blocker.release();
      await rebuilding;
    }
  });
});
