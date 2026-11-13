import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { FingerprintService } from "./fingerprint.service";
import { HealthController } from "./health.controller";
import { HttpMetricsInterceptor } from "./http-metrics.interceptor";
import { GracefulShutdownService } from "./graceful-shutdown.service";
import { JsonLoggerService } from "./json-logger.service";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

@Global()
@Module({
  controllers: [MetricsController, HealthController],
  providers: [
    MetricsService,
    FingerprintService,
    JsonLoggerService,
    GracefulShutdownService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [
    MetricsService,
    FingerprintService,
    JsonLoggerService,
    GracefulShutdownService,
  ],
})
export class ObservabilityModule {}
