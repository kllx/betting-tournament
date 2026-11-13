import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChannelModel, ConfirmChannel, ConsumeMessage, connect } from "amqplib";
import {
  EventSigner,
  MessageAuthenticationError,
} from "../security/event-signer";
import { EVENT_DOMAINS } from "./contracts";
import { publishMandatory } from "./publish-mandatory";
import { waitForDrain } from "./drain";

export class PermanentMessageError extends Error {}

export abstract class SignedInternalConsumer {
  protected readonly logger = new Logger(this.constructor.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private consumerTag?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly signer: EventSigner;

  protected abstract readonly queueSuffix: string;

  protected constructor(protected readonly config: ConfigService) {
    this.signer = new EventSigner(
      config.getOrThrow<string>("security.internalSigningSecret"),
      EVENT_DOMAINS.INTERNAL,
    );
  }

  protected abstract process(payload: unknown): Promise<void>;

  protected async start(routingKey: string, prefetch: number): Promise<void> {
    if (this.stopping) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    await this.closeConnection();
    const exchange = this.config.getOrThrow<string>("rabbitmq.exchange");
    const queue = `${this.config.getOrThrow<string>("rabbitmq.queue")}.${this.queueSuffix}`;
    const retryQueue = `${queue}.retry`;
    const retryExchange = `${exchange}.retry`;
    const connection = await connect(
      this.config.getOrThrow<string>("rabbitmq.url"),
    );
    this.connection = connection;
    connection.on("error", (error) => {
      this.logger.error(`RabbitMQ connection error: ${error.message}`);
    });
    connection.on("close", () => {
      if (this.connection === connection) {
        this.scheduleReconnect(routingKey, prefetch);
      }
    });
    const channel = await connection.createConfirmChannel();
    this.channel = channel;
    channel.on("error", (error) => {
      this.logger.error(`RabbitMQ channel error: ${error.message}`);
    });
    channel.on("close", () => {
      if (this.channel === channel) {
        this.scheduleReconnect(routingKey, prefetch);
      }
    });
    await this.channel.assertExchange(retryExchange, "topic", {
      durable: true,
    });
    await this.channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: `${exchange}.dlx`,
      deadLetterRoutingKey: "dead-letter",
      arguments: { "x-queue-type": "quorum" },
    });
    await this.channel.bindQueue(queue, exchange, routingKey);
    await this.channel.assertQueue(retryQueue, {
      durable: true,
      deadLetterExchange: exchange,
      deadLetterRoutingKey: routingKey,
      arguments: {
        "x-queue-type": "quorum",
        "x-message-ttl": this.config.getOrThrow<number>("rabbitmq.retryTtlMs"),
      },
    });
    await this.channel.bindQueue(retryQueue, retryExchange, routingKey);
    await this.channel.prefetch(prefetch);
    const consumer = await this.channel.consume(queue, (message) => {
      if (message) {
        const task = this.handle(message).catch((error: unknown) => {
          this.logger.error("Internal message handling failed", error);
        });
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task));
      }
    });
    this.consumerTag = consumer.consumerTag;
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    this.consumerTag = undefined;
    if (connection) {
      await connection.close().catch(() => undefined);
    }
  }

  private scheduleReconnect(routingKey: string, prefetch: number): void {
    if (this.stopping) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.start(routingKey, prefetch).catch((error: unknown) => {
        this.logger.error(`RabbitMQ reconnect failed: ${String(error)}`);
        this.scheduleReconnect(routingKey, prefetch);
      });
    }, this.config.getOrThrow<number>("shutdown.rabbitmqReconnectDelayMs"));
    this.reconnectTimer.unref();
  }

  protected async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    if (this.channel && this.consumerTag) {
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
    }
    await waitForDrain(
      this.pending,
      this.config.getOrThrow<number>("shutdown.workerDrainTimeoutMs"),
    );
    await this.closeConnection();
  }

  private async handle(message: ConsumeMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      return;
    }
    const routingKey = message.fields.routingKey;
    try {
      const raw = message.content.toString();
      this.signer.verify(routingKey, raw, message.properties.headers);
      const payload = JSON.parse(raw) as unknown;
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        throw new SyntaxError("Internal event payload must be an object");
      }
      await this.process(payload);
      channel.ack(message);
    } catch (error) {
      const permanent =
        error instanceof MessageAuthenticationError ||
        error instanceof SyntaxError ||
        error instanceof PermanentMessageError;
      const retries = Number(
        message.properties.headers?.["x-retry-count"] ?? 0,
      );
      if (!Number.isSafeInteger(retries) || retries < 0) {
        channel.nack(message, false, false);
        return;
      }
      if (
        permanent ||
        retries >= this.config.getOrThrow<number>("rabbitmq.maxRetries")
      ) {
        channel.nack(message, false, false);
        return;
      }
      if (this.stopping) {
        channel.nack(message, false, true);
        return;
      }
      try {
        await publishMandatory(
          channel,
          `${this.config.getOrThrow<string>("rabbitmq.exchange")}.retry`,
          routingKey,
          message.content,
          {
            contentType: message.properties.contentType ?? "application/json",
            messageId: message.properties.messageId,
            persistent: true,
            headers: {
              ...message.properties.headers,
              "x-retry-count": retries + 1,
            },
          },
          this.config.getOrThrow<number>("rabbitmq.publishConfirmTimeoutMs"),
        );
        channel.ack(message);
      } catch {
        channel.nack(message, false, true);
      }
    }
  }
}
