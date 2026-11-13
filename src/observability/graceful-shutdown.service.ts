import {
  BeforeApplicationShutdown,
  INestApplication,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpTerminator } from "./http-terminator";

@Injectable()
export class GracefulShutdownService implements BeforeApplicationShutdown {
  private app?: INestApplication;
  private terminator?: HttpTerminator;

  constructor(private readonly config: ConfigService) {}

  setup(app: INestApplication): void {
    this.app = app;
    this.terminator = new HttpTerminator(
      app.getHttpServer(),
      this.config.getOrThrow<number>("shutdown.gracePeriodMs"),
      this.config.getOrThrow<number>("shutdown.connectionCheckIntervalMs"),
    );
  }

  get isTerminating(): boolean {
    return this.terminator?.isTerminating ?? false;
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.app || !this.terminator) {
      return;
    }
    await this.terminator.terminate();
  }
}
