import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LIMITS } from "../config/limits";
import { LeaderboardPhaseService } from "./leaderboard-phase.service";
import { LeaderboardProjection } from "./leaderboard.projection";

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  points: number;
}

export interface LeaderboardResponse {
  top: LeaderboardEntry[];
  player: LeaderboardEntry | null;
}

interface RankedPlayerRow {
  rank: string | number;
  player_id: string;
  points: number;
}

const consumeFallbackScript = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: Redis,
    private readonly config?: ConfigService,
    @Optional() private readonly phase?: LeaderboardPhaseService,
  ) {}

  async getLeaderboard(playerId: string): Promise<LeaderboardResponse> {
    const phase = this.phase
      ? await this.phase.get()
      : (
          await this.dataSource.query(
            "SELECT phase FROM tournament_state WHERE id = 1",
          )
        )[0]?.phase;
    const finalized = phase !== "ACTIVE";
    if (!finalized) {
      try {
        return await this.getFromRedis(playerId);
      } catch (error) {
        this.logger.error(
          "Redis leaderboard read failed, using PostgreSQL",
          error,
        );
      }
      await this.consumeFallbackBudget();
    }
    return this.getFromPostgres(playerId, finalized);
  }

  private async getFromRedis(playerId: string): Promise<LeaderboardResponse> {
    if ((await this.redis.get(LeaderboardProjection.readyKey)) !== "1") {
      throw new Error("Leaderboard projection is not ready");
    }
    const [top, currentMember] = await Promise.all([
      this.redis.zrevrange(
        LeaderboardProjection.playersKey,
        0,
        LIMITS.LEADERBOARD_SIZE - 1,
        "WITHSCORES",
      ),
      this.redis.hget(LeaderboardProjection.membersKey, playerId),
    ]);
    const entries: LeaderboardEntry[] = [];
    for (let index = 0; index < top.length; index += 2) {
      entries.push({
        rank: index / 2 + 1,
        playerId: top[index].slice(top[index].indexOf(":") + 1),
        points: Number(top[index + 1]),
      });
    }

    let player: LeaderboardEntry | null = null;
    if (currentMember) {
      const [rank, points] = await Promise.all([
        this.redis.zrevrank(LeaderboardProjection.playersKey, currentMember),
        this.redis.zscore(LeaderboardProjection.playersKey, currentMember),
      ]);
      if (rank !== null && points !== null) {
        player = { rank: rank + 1, playerId, points: Number(points) };
      }
    }
    return { top: entries, player };
  }

  private async getFromPostgres(
    playerId: string,
    finalized: boolean,
  ): Promise<LeaderboardResponse> {
    const rows: RankedPlayerRow[] = await this.dataSource.query(
      finalized
        ? `SELECT rank, player_id, points
           FROM leaderboard_snapshots
           WHERE rank <= $1 OR player_id = $2
           ORDER BY rank`
        : `WITH top AS (
             SELECT player_id, points,
                    ROW_NUMBER() OVER (
                      ORDER BY points DESC, points_reached_at ASC, player_id DESC
                    ) AS rank
             FROM players
             ORDER BY points DESC, points_reached_at ASC, player_id DESC
             LIMIT $1
           ), requested AS (
             SELECT player_id, points, points_reached_at
             FROM players WHERE player_id = $2
           ), requested_rank AS (
             SELECT count(*) FILTER (
               WHERE players.points > requested.points
                  OR (players.points = requested.points
                    AND players.points_reached_at < requested.points_reached_at)
                  OR (players.points = requested.points
                    AND players.points_reached_at = requested.points_reached_at
                    AND players.player_id > requested.player_id)
             ) AS better
             FROM players, requested
           )
           SELECT rank, player_id, points FROM top
           UNION ALL
           SELECT requested_rank.better + 1 AS rank,
                  requested.player_id,
                  requested.points
           FROM requested, requested_rank
           WHERE requested.player_id NOT IN (SELECT player_id FROM top)
           ORDER BY rank`,
      [LIMITS.LEADERBOARD_SIZE, playerId],
    );
    return this.mapRows(rows, playerId);
  }

  private async consumeFallbackBudget(): Promise<void> {
    if (!this.config) {
      throw new ServiceUnavailableException("Fallback limiter unavailable");
    }
    const windowMs = this.config.getOrThrow<number>(
      "rateLimit.postgresFallbackWindowMs",
    );
    const maxRequests = this.config.getOrThrow<number>(
      "rateLimit.postgresFallbackMaxRequests",
    );
    const bucket = Math.floor(Date.now() / windowMs);
    try {
      const count = (await this.redis.eval(
        consumeFallbackScript,
        1,
        `leaderboard:postgres-fallback:${bucket}`,
        windowMs,
      )) as number;
      if (count > maxRequests) {
        throw new ServiceUnavailableException(
          "PostgreSQL fallback capacity exhausted",
        );
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException("Fallback limiter unavailable");
    }
  }

  private mapRows(
    rows: RankedPlayerRow[],
    playerId: string,
  ): LeaderboardResponse {
    const entries = rows.map((row) => ({
      rank: Number(row.rank),
      playerId: row.player_id,
      points: row.points,
    }));
    return {
      top: entries.filter((entry) => entry.rank <= LIMITS.LEADERBOARD_SIZE),
      player: entries.find((entry) => entry.playerId === playerId) ?? null,
    };
  }
}
