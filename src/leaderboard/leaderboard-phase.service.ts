import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { DataSource } from "typeorm";

export type CachedTournamentPhase = "ACTIVE" | "PAYING" | "PAID";

export interface TournamentPhaseProjection {
  phase: CachedTournamentPhase;
  version: string;
}

const applyPhaseScript = `
  local current = redis.call('GET', KEYS[1])
  if current then
    local decoded = cjson.decode(current)
    if tonumber(decoded.version) > tonumber(ARGV[2]) then
      return 0
    end
  end
  local encoded = cjson.encode({phase = ARGV[1], version = ARGV[2]})
  if ARGV[1] == 'ACTIVE' then
    redis.call('SET', KEYS[1], encoded, 'PX', ARGV[3])
  else
    redis.call('SET', KEYS[1], encoded)
  end
  return 1
`;

@Injectable()
export class LeaderboardPhaseService {
  static readonly key = "tournament:phase";

  constructor(
    private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async get(): Promise<CachedTournamentPhase> {
    try {
      const cached = await this.redis.get(LeaderboardPhaseService.key);
      if (cached) {
        const projection = JSON.parse(cached) as TournamentPhaseProjection;
        if (this.valid(projection)) {
          return projection.phase;
        }
      }
    } catch {
      return this.getFromPostgres(false);
    }
    return this.getFromPostgres(true);
  }

  async apply(projection: TournamentPhaseProjection): Promise<void> {
    if (!this.valid(projection)) {
      throw new SyntaxError("Invalid tournament phase projection");
    }
    await this.redis.eval(
      applyPhaseScript,
      1,
      LeaderboardPhaseService.key,
      projection.phase,
      projection.version,
      this.config.getOrThrow<number>("leaderboard.activePhaseTtlMs"),
    );
  }

  private async getFromPostgres(
    cache: boolean,
  ): Promise<CachedTournamentPhase> {
    const rows = await this.dataSource.query(
      `SELECT phase,
              COALESCE(floor(extract(epoch FROM finalized_at) * 1000000), 0)::text AS version
       FROM tournament_state WHERE id = 1`,
    );
    const projection = rows[0] as TournamentPhaseProjection;
    if (cache) {
      await this.apply(projection).catch(() => undefined);
    }
    return projection.phase;
  }

  private valid(projection: TournamentPhaseProjection): boolean {
    return (
      ["ACTIVE", "PAYING", "PAID"].includes(projection.phase) &&
      /^\d+$/.test(projection.version) &&
      Number.isSafeInteger(Number(projection.version))
    );
  }
}
