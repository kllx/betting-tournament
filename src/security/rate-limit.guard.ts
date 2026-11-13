import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import Redis from "ioredis";
import {
  RATE_LIMIT_SCOPE_KEY,
  RateLimitScope,
} from "./rate-limit-scope.decorator";

const consumeScript = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const scope =
      this.reflector.getAllAndOverride<RateLimitScope>(RATE_LIMIT_SCOPE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? "leaderboard";
    const windowMs = this.config.getOrThrow<number>(
      `rateLimit.${scope}WindowMs`,
    );
    const maxRequests = this.config.getOrThrow<number>(
      `rateLimit.${scope}MaxRequests`,
    );
    const client = request.ip ?? request.socket.remoteAddress ?? "unknown";
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `rate:${scope}:${client}:${bucket}`;

    try {
      const count = (await this.redis.eval(
        consumeScript,
        1,
        key,
        windowMs,
      )) as number;
      if (count > maxRequests) {
        throw new HttpException(
          "Too many requests",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new ServiceUnavailableException("Rate limiter unavailable");
    }
  }
}
