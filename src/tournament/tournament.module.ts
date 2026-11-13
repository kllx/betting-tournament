import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { Money } from "../money";
import { MetricsService } from "../observability/metrics.service";
import { OutboxRelay } from "../outbox/outbox.relay";
import { OutboxScheduler } from "../outbox/outbox.scheduler";
import { RabbitMqPublisher } from "../outbox/rabbitmq.publisher";
import { PayoutConsumer } from "../payouts/payout.consumer";
import { PayoutService } from "../payouts/payout.service";
import { RedisModule } from "../redis/redis.module";
import { RateLimitGuard } from "../security/rate-limit.guard";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { TournamentScheduler } from "./tournament.scheduler";
import { TournamentService } from "./tournament.service";
import { TournamentStateInitializer } from "./tournament-state.initializer";

@Module({
  imports: [RedisModule],
  controllers: [AdminController],
  providers: [
    {
      provide: TournamentService,
      inject: [DataSource, ConfigService],
      useFactory: (dataSource: DataSource, config: ConfigService) =>
        new TournamentService(
          dataSource,
          config.getOrThrow<Money[]>("tournament.prizes"),
        ),
    },
    {
      provide: PayoutService,
      inject: [DataSource, MetricsService],
      useFactory: (dataSource: DataSource, metrics: MetricsService) =>
        new PayoutService(dataSource, metrics),
    },
    {
      provide: OutboxRelay,
      inject: [DataSource, RabbitMqPublisher, ConfigService, MetricsService],
      useFactory: (
        dataSource: DataSource,
        publisher: RabbitMqPublisher,
        config: ConfigService,
        metrics: MetricsService,
      ) =>
        new OutboxRelay(
          dataSource,
          publisher,
          config.getOrThrow<number>("outbox.batchSize"),
          metrics,
          config.getOrThrow<number>("outbox.publishConcurrency"),
          config.getOrThrow<number>("outbox.maxAttempts"),
        ),
    },
    RabbitMqPublisher,
    OutboxScheduler,
    PayoutConsumer,
    TournamentStateInitializer,
    TournamentScheduler,
    AdminGuard,
    RateLimitGuard,
  ],
  exports: [TournamentService, PayoutService, OutboxRelay, RabbitMqPublisher],
})
export class TournamentModule {}
