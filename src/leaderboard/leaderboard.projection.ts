import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LIMITS } from "../config/limits";
import { ReconciliationLock } from "./reconciliation-lock";

export interface ScoreProjection {
  playerId: string;
  points: number;
  pointsReachedAt: string;
  pointsReachedAtUs?: string;
  scoreVersion?: string;
}

interface PlayerProjectionRow {
  player_id: string;
  points: number;
  points_reached_at: Date;
  points_reached_at_us: string;
  score_version: string;
}

interface OutboxProjectionRow {
  id: string;
  payload: ScoreProjection;
}

interface ProjectionKeys {
  players: string;
  members: string;
  versions: string;
}

function readScript(name: string): string {
  const sourcePath = join(__dirname, "lua", name);
  const bundledPath = join(__dirname, "..", "..", "leaderboard", "lua", name);
  return readFileSync(
    existsSync(sourcePath) ? sourcePath : bundledPath,
    "utf8",
  );
}

const applyScript = readScript("apply-score.lua");
const swapProjectionScript = readScript("swap-projection.lua");
const liveKeys: ProjectionKeys = {
  players: "tournament:leaderboard:players",
  members: "tournament:leaderboard:members",
  versions: "tournament:leaderboard:versions",
};
function stagingKeys(token: string): ProjectionKeys {
  const prefix = `tournament:leaderboard:staging:${token}`;
  return {
    players: `${prefix}:players`,
    members: `${prefix}:members`,
    versions: `${prefix}:versions`,
  };
}

function stagingReadyKey(token: string): string {
  return `tournament:leaderboard:staging:${token}:ready`;
}

export class LeaderboardProjection {
  static readonly playersKey = liveKeys.players;
  static readonly membersKey = liveKeys.members;
  static readonly versionsKey = liveKeys.versions;
  static readonly lastOutboxIdKey = "tournament:leaderboard:last-outbox-id";
  static readonly readyKey = "tournament:leaderboard:ready";

  constructor(
    private readonly redis: Redis,
    private readonly dataSource: DataSource,
  ) {}

  async apply(score: ScoreProjection): Promise<void> {
    if (
      !/^[A-Za-z0-9._:-]{1,128}$/.test(score.playerId) ||
      !Number.isInteger(score.points) ||
      score.points < 0 ||
      score.points > LIMITS.MAX_PLAYER_POINTS ||
      !Number.isFinite(Date.parse(score.pointsReachedAt)) ||
      (score.pointsReachedAtUs !== undefined &&
        (!/^\d+$/.test(score.pointsReachedAtUs) ||
          !Number.isSafeInteger(Number(score.pointsReachedAtUs)))) ||
      (score.scoreVersion !== undefined &&
        (!/^\d+$/.test(score.scoreVersion) ||
          !Number.isSafeInteger(Number(score.scoreVersion))))
    ) {
      throw new SyntaxError("Invalid score projection");
    }
    await this.redis.eval(
      applyScript,
      3,
      liveKeys.players,
      liveKeys.members,
      liveKeys.versions,
      score.playerId,
      this.member(score),
      score.points,
      this.version(score),
    );
  }

  async rebuild(): Promise<boolean> {
    const lock = await this.acquireLock();
    if (!lock) {
      return false;
    }
    const ownerToken = lock.ownerToken;
    const keys = stagingKeys(ownerToken);
    const readyKey = stagingReadyKey(ownerToken);
    try {
      await this.dataSource.transaction("REPEATABLE READ", async (manager) => {
        await manager.query("SET TRANSACTION READ ONLY");
        const maxOutbox = await manager.query(
          "SELECT COALESCE(MAX(id), 0) AS id FROM outbox",
        );
        let lastPlayerId = "";
        while (true) {
          const players: PlayerProjectionRow[] = await manager.query(
            `SELECT player_id, points, points_reached_at, score_version,
                    floor(extract(epoch FROM points_reached_at) * 1000000)::bigint AS points_reached_at_us
             FROM players WHERE player_id > $1 ORDER BY player_id LIMIT $2`,
            [lastPlayerId, LIMITS.PROJECTION_BATCH_SIZE],
          );
          if (players.length === 0) {
            break;
          }
          await lock.assertOwnership();
          await this.applyBatch(players, keys);
          lastPlayerId = players[players.length - 1].player_id;
        }
        await this.redis.set(readyKey, "1");
        await lock.assertOwnership();
        const swapped = await this.redis.eval(
          swapProjectionScript,
          10,
          liveKeys.players,
          liveKeys.members,
          liveKeys.versions,
          keys.players,
          keys.members,
          keys.versions,
          LeaderboardProjection.lastOutboxIdKey,
          ReconciliationLock.key,
          readyKey,
          LeaderboardProjection.readyKey,
          maxOutbox[0].id,
          ownerToken,
        );
        if (swapped === 0) {
          throw new Error("Reconciliation lock lost");
        }
        if (swapped !== 1) {
          throw new Error("Projection staging is incomplete");
        }
      });
      return true;
    } finally {
      await this.redis
        .del(keys.players, keys.members, keys.versions, readyKey)
        .catch(() => undefined);
      await this.releaseLock(lock);
    }
  }

  async isReady(): Promise<boolean> {
    return (await this.redis.get(LeaderboardProjection.readyKey)) === "1";
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.isReady()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Projection readiness timeout");
  }

  async reconcile(): Promise<void> {
    if (!(await this.isReady())) {
      await this.rebuild();
      return;
    }
    const lock = await this.acquireLock();
    if (!lock) {
      return;
    }
    try {
      while (true) {
        const lastOutboxId = Number(
          (await this.redis.get(LeaderboardProjection.lastOutboxIdKey)) ?? "0",
        );
        const records = await this.dataSource.transaction(async (manager) => {
          await manager.query(
            "SELECT id FROM tournament_state WHERE id = 1 FOR UPDATE",
          );
          const rows: OutboxProjectionRow[] = await manager.query(
            `SELECT id, payload FROM outbox
             WHERE event_type = 'player.score.changed' AND id > $1
             ORDER BY id LIMIT $2`,
            [lastOutboxId, LIMITS.PROJECTION_BATCH_SIZE],
          );
          return rows;
        });
        if (records.length === 0) {
          return;
        }
        await lock.assertOwnership();
        for (const record of records) {
          await this.apply(record.payload);
        }
        await lock.assertOwnership();
        await this.redis.set(
          LeaderboardProjection.lastOutboxIdKey,
          records[records.length - 1].id,
        );
        if (records.length < LIMITS.PROJECTION_BATCH_SIZE) {
          return;
        }
      }
    } finally {
      await this.releaseLock(lock);
    }
  }

  private async applyBatch(
    players: PlayerProjectionRow[],
    keys: ProjectionKeys,
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const player of players) {
      const score: ScoreProjection = {
        playerId: player.player_id,
        points: player.points,
        pointsReachedAt: player.points_reached_at.toISOString(),
        pointsReachedAtUs: player.points_reached_at_us,
        scoreVersion: player.score_version,
      };
      pipeline.eval(
        applyScript,
        3,
        keys.players,
        keys.members,
        keys.versions,
        score.playerId,
        this.member(score),
        score.points,
        this.version(score),
      );
    }
    const results = (await pipeline.exec()) as Array<[unknown, unknown]>;
    for (const [error] of results) {
      if (error) {
        throw error instanceof Error
          ? error
          : new Error("Redis command failed");
      }
    }
  }

  private async acquireLock(): Promise<ReconciliationLock | null> {
    const lock = new ReconciliationLock(this.redis);
    if (await lock.acquire()) {
      return lock;
    }
    return null;
  }

  private async releaseLock(lock: ReconciliationLock): Promise<void> {
    await lock.release();
  }

  private version(score: ScoreProjection): string {
    return (
      score.scoreVersion ?? String(Date.parse(score.pointsReachedAt) * 1000)
    );
  }

  private member(score: ScoreProjection): string {
    const timestamp =
      score.pointsReachedAtUs ??
      String(Date.parse(score.pointsReachedAt) * 1000);
    const inverseTimestamp = Number.MAX_SAFE_INTEGER - Number(timestamp);
    return `${String(inverseTimestamp).padStart(16, "0")}:${score.playerId}`;
  }
}
