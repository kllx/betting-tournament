import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { Money } from "../money";
import { FingerprintService } from "../observability/fingerprint.service";
import { MetricsService } from "../observability/metrics.service";
import { PointsCalculator } from "../scoring/points-calculator";
import { BetProcessingService } from "./bet-processing.service";
import { RabbitMqConsumer } from "./rabbitmq.consumer";

@Module({
  providers: [
    {
      provide: PointsCalculator,
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService, metrics: MetricsService) =>
        new PointsCalculator(
          config.getOrThrow<Record<string, Money>>("fxRates"),
          config.getOrThrow<number>("security.maxWinAmountUsd"),
          metrics,
        ),
    },
    {
      provide: BetProcessingService,
      inject: [
        DataSource,
        PointsCalculator,
        FingerprintService,
        MetricsService,
      ],
      useFactory: (
        dataSource: DataSource,
        calculator: PointsCalculator,
        fingerprint: FingerprintService,
        metrics: MetricsService,
      ) =>
        new BetProcessingService(dataSource, calculator, fingerprint, metrics),
    },
    RabbitMqConsumer,
  ],
  exports: [BetProcessingService],
})
export class BetsModule {}
