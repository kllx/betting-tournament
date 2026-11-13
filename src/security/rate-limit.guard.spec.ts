import { ExecutionContext, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import Redis from "ioredis";
import { RateLimitGuard } from "./rate-limit.guard";

describe("RateLimitGuard failures", () => {
  it("fails closed when the distributed limiter is unavailable", async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error("redis down")),
    } as unknown as Redis;
    const config = new ConfigService({
      rateLimit: { leaderboardWindowMs: 1000, leaderboardMaxRequests: 10 },
    });
    const reflector = {
      getAllAndOverride: () => "leaderboard",
    } as unknown as Reflector;
    const guard = new RateLimitGuard(redis, config, reflector);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ ip: "127.0.0.1", socket: {} }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
