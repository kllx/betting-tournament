import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { JsonLoggerService } from "./observability/json-logger.service";
import { GracefulShutdownService } from "./observability/graceful-shutdown.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  app.useLogger(app.get(JsonLoggerService));
  app.set("trust proxy", config.getOrThrow<number>("trustProxy"));
  app.enableShutdownHooks();
  app.get(GracefulShutdownService).setup(app);
  await app.listen(config.getOrThrow<number>("port"));
}

void bootstrap();
