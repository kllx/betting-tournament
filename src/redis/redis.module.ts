import { Global, Module, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Global()
@Module({
  providers: [
    {
      provide: Redis,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>("redisUrl"), {
          maxRetriesPerRequest: config.getOrThrow<number>(
            "redis.maxRetriesPerRequest",
          ),
          commandTimeout: config.getOrThrow<number>("redis.commandTimeoutMs"),
          connectTimeout: config.getOrThrow<number>("redis.connectTimeoutMs"),
        }),
    },
  ],
  exports: [Redis],
})
export class RedisModule implements OnModuleDestroy {
  constructor(private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
