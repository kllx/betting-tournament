import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { RedisModule } from "../redis/redis.module";
import { RateLimitGuard } from "../security/rate-limit.guard";
import { LeaderboardPhaseService } from "./leaderboard-phase.service";
import { LeaderboardConsumer } from "./leaderboard.consumer";
import { LeaderboardController } from "./leaderboard.controller";
import { LeaderboardProjection } from "./leaderboard.projection";
import { LeaderboardService } from "./leaderboard.service";
import { TournamentPhaseConsumer } from "./tournament-phase.consumer";

@Module({
  imports: [RedisModule],
  controllers: [LeaderboardController],
  providers: [
    {
      provide: LeaderboardProjection,
      inject: [Redis, DataSource],
      useFactory: (redis: Redis, dataSource: DataSource) =>
        new LeaderboardProjection(redis, dataSource),
    },
    {
      provide: LeaderboardPhaseService,
      inject: [Redis, DataSource, ConfigService],
      useFactory: (
        redis: Redis,
        dataSource: DataSource,
        config: ConfigService,
      ) => new LeaderboardPhaseService(redis, dataSource, config),
    },
    LeaderboardService,
    LeaderboardConsumer,
    TournamentPhaseConsumer,
    RateLimitGuard,
  ],
  exports: [RedisModule, LeaderboardProjection, LeaderboardService],
})
export class LeaderboardModule {}
