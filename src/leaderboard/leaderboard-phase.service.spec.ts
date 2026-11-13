import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardPhaseService } from "./leaderboard-phase.service";

describe("LeaderboardPhaseService", () => {
  it("does not downgrade a finalized phase with a stale active write", () => {
    let cached = "";
    let cachedVersion = -1;
    const redis = {
      eval: jest
        .fn()
        .mockImplementation((_script, _keys, _key, phase, version) => {
          if (Number(version) >= cachedVersion) {
            cached = JSON.stringify({ phase, version });
            cachedVersion = Number(version);
          }
          return Promise.resolve(1);
        }),
      get: jest.fn().mockImplementation(() => Promise.resolve(cached)),
    } as unknown as Redis;
    const query = jest.fn();
    const dataSource = { query } as unknown as DataSource;
    const service = new LeaderboardPhaseService(
      redis,
      dataSource,
      new ConfigService({ leaderboard: { activePhaseTtlMs: 1000 } }),
    );

    return expect(
      (async () => {
        await service.apply({ phase: "PAYING", version: "100" });
        await service.apply({ phase: "ACTIVE", version: "0" });

        await expect(service.get()).resolves.toBe("PAYING");
        expect(query).not.toHaveBeenCalled();
      })(),
    ).resolves.toBeUndefined();
  });

  it("loads and caches the phase from PostgreSQL on a cache miss", () => {
    let cached = "";
    const redis = {
      get: jest.fn().mockImplementation(() => Promise.resolve(cached || null)),
      eval: jest
        .fn()
        .mockImplementation((_script, _keys, _key, phase, version) => {
          cached = JSON.stringify({ phase, version });
          return Promise.resolve(1);
        }),
    } as unknown as Redis;
    const query = jest
      .fn()
      .mockResolvedValue([{ phase: "ACTIVE", version: "0" }]);
    const dataSource = { query } as unknown as DataSource;
    const service = new LeaderboardPhaseService(
      redis,
      dataSource,
      new ConfigService({ leaderboard: { activePhaseTtlMs: 1000 } }),
    );

    return expect(
      (async () => {
        await expect(service.get()).resolves.toBe("ACTIVE");
        await expect(service.get()).resolves.toBe("ACTIVE");
        expect(query).toHaveBeenCalledTimes(1);
      })(),
    ).resolves.toBeUndefined();
  });
});
