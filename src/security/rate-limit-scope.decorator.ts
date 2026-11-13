import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_SCOPE_KEY = "rate-limit:scope";
export type RateLimitScope = "admin" | "leaderboard";

export const RateLimitScope = (scope: RateLimitScope) =>
  SetMetadata(RATE_LIMIT_SCOPE_KEY, scope);
