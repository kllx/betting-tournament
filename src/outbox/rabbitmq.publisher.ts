import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChannelModel, ConfirmChannel, connect } from "amqplib";
import { EVENT_DOMAINS } from "../messaging/contracts";
import { publishMandatory } from "../messaging/publish-mandatory";
import { MetricsService } from "../observability/metrics.service";
import { EventSigner } from "../security/event-signer";
import { OutboxPublisher } from "./outbox.relay";

@Injectable()
export class RabbitMqPublisher implements OutboxPublisher, OnModuleInit {
  private readonly logger = new Logger(RabbitMqPublisher.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;
  private readonly signer: EventSigner;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.signer = new EventSigner(
      config.getOrThrow<string>("security.internalSigningSecret"),
      EVENT_DOMAINS.INTERNAL,
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.stopping) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    await this.closeConnection();
    const connection = await connect(
      this.config.getOrThrow<string>("rabbitmq.url"),
    );
    this.connection = connection;
    connection.on("error", (error) => {
      this.logger.error(`RabbitMQ connection error: ${error.message}`);
    });
    connection.on("close", () => {
      if (this.connection === connection) {
        this.scheduleReconnect();
      }
    });
    const channel = await connection.createConfirmChannel();
    this.channel = channel;
    channel.on("error", (error) => {
      this.logger.error(`RabbitMQ channel error: ${error.message}`);
    });
    channel.on("close", () => {
      if (this.channel === channel) {
        this.scheduleReconnect();
      }
    });
    await this.channel.assertExchange(
      this.config.getOrThrow<string>("rabbitmq.exchange"),
      "topic",
      { durable: true },
    );
  }

  async publish(
    eventType: string,
    payload: unknown,
    eventId: string,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error("RabbitMQ publisher is not initialized");
    }
    const body = JSON.stringify(payload);
    const started = performance.now();
    try {
      await publishMandatory(
        this.channel,
        this.config.getOrThrow<string>("rabbitmq.exchange"),
        eventType,
        Buffer.from(body),
        {
          contentType: "application/json",
          messageId: eventId,
          persistent: true,
          headers: this.signer.sign(eventType, body, eventId),
        },
        this.config.getOrThrow<number>("rabbitmq.publishConfirmTimeoutMs"),
      );
      this.metrics?.rabbitmqPublished(
        eventType,
        "SUCCESS",
        performance.now() - started,
      );
    } catch (error) {
      this.metrics?.rabbitmqPublished(
        eventType,
        "ERROR",
        performance.now() - started,
      );
      throw error;
    }
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    if (connection) {
      await connection.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    await this.closeConnection();
  }

  private scheduleReconnect(): void {
    if (this.stopping) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.onModuleInit().catch((error: unknown) => {
        this.logger.error(`RabbitMQ reconnect failed: ${String(error)}`);
        this.scheduleReconnect();
      });
    }, this.config.getOrThrow<number>("shutdown.rabbitmqReconnectDelayMs"));
    this.reconnectTimer.unref();
  }
}
