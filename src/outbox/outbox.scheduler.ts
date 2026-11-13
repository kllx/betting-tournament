import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OutboxRelay } from "./outbox.relay";
import { RabbitMqPublisher } from "./rabbitmq.publisher";
import { waitForDrain } from "../messaging/drain";

@Injectable()
export class OutboxScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxScheduler.name);
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly relay: OutboxRelay,
    private readonly config: ConfigService,
    private readonly publisher: RabbitMqPublisher,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (!this.flushing) {
        this.pending = this.flush();
      }
    }, this.config.getOrThrow<number>("outbox.pollIntervalMs"));
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await waitForDrain(
      [this.pending],
      this.config.getOrThrow<number>("shutdown.workerDrainTimeoutMs"),
    );
    await this.publisher.close();
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      await this.relay.flush();
    } catch (error) {
      this.logger.error("Outbox flush failed", error);
    } finally {
      this.flushing = false;
    }
  }
}
