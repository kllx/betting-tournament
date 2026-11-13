import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TournamentService } from "./tournament.service";
import { waitForDrain } from "../messaging/drain";

@Injectable()
export class TournamentScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TournamentScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly tournament: TournamentService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (!this.running) {
        this.pending = this.finalize();
      }
    }, this.config.getOrThrow<number>("tournament.finalizerIntervalMs"));
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await waitForDrain(
      [this.pending],
      this.config.getOrThrow<number>("shutdown.workerDrainTimeoutMs"),
    );
  }

  private async finalize(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.tournament.finalizeDue();
    } catch (error) {
      this.logger.error("Tournament finalization failed", error);
    } finally {
      this.running = false;
    }
  }
}
