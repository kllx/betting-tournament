import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChannelModel, ConfirmChannel, ConsumeMessage, connect } from "amqplib";
import { publishMandatory } from "../messaging/publish-mandatory";
import { waitForDrain } from "../messaging/drain";
import { UnsupportedCurrencyError } from "../scoring/points-calculator";
import {
  EventSigner,
  MessageAuthenticationError,
} from "../security/event-signer";
import {
  BetPayloadConflictError,
  EventPayloadConflictError,
} from "../security/fingerprint";
import {
  BetEventValidationError,
  parseBetEventJson,
  validateBetEvent,
} from "./bet-event";
import { BetProcessingService } from "./bet-processing.service";

@Injectable()
export class RabbitMqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private consumerTag?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly signer: EventSigner;

  constructor(
    private readonly config: ConfigService,
    private readonly betProcessing: BetProcessingService,
  ) {
    this.signer = new EventSigner(
      config.getOrThrow<string>("security.eventSigningSecret"),
      "bet-event-v1",
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.stopping) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    await this.closeConnection();
    const exchange = this.config.getOrThrow<string>("rabbitmq.exchange");
    const queue = this.config.getOrThrow<string>("rabbitmq.queue");
    const prefetch = this.config.getOrThrow<number>("rabbitmq.prefetch");
    const retryTtl = this.config.getOrThrow<number>("rabbitmq.retryTtlMs");
    const deadLetterExchange = `${exchange}.dlx`;
    const retryExchange = `${exchange}.retry`;
    const deadLetterQueue = `${queue}.dlq`;

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

    await this.channel.assertExchange(exchange, "topic", { durable: true });
    await this.channel.assertExchange(deadLetterExchange, "topic", {
      durable: true,
    });
    await this.channel.assertExchange(retryExchange, "topic", {
      durable: true,
    });
    await this.channel.assertQueue(deadLetterQueue, {
      durable: true,
      arguments: { "x-queue-type": "quorum" },
    });
    await this.channel.bindQueue(
      deadLetterQueue,
      deadLetterExchange,
      "dead-letter",
    );
    await this.channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange,
      deadLetterRoutingKey: "dead-letter",
      arguments: { "x-queue-type": "quorum" },
    });
    await this.channel.bindQueue(queue, exchange, "bet.settled");
    await this.channel.bindQueue(queue, exchange, "bet.rollback");

    for (const routingKey of ["bet.settled", "bet.rollback"]) {
      const retryQueue = `${queue}.retry.${routingKey === "bet.settled" ? "settled" : "rollback"}`;
      await this.channel.assertQueue(retryQueue, {
        durable: true,
        deadLetterExchange: exchange,
        deadLetterRoutingKey: routingKey,
        arguments: {
          "x-queue-type": "quorum",
          "x-message-ttl": retryTtl,
        },
      });
      await this.channel.bindQueue(retryQueue, retryExchange, routingKey);
    }

    await this.channel.prefetch(prefetch);
    const consumer = await this.channel.consume(queue, (message) => {
      if (message) {
        const task = this.handleMessage(message).catch((error: unknown) => {
          this.logger.error("Failed to settle RabbitMQ message state", error);
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

  async onModuleDestroy(): Promise<void> {
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

  private async handleMessage(message: ConsumeMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      return;
    }
    const routingKey = message.fields.routingKey;

    try {
      if (routingKey !== "bet.settled" && routingKey !== "bet.rollback") {
        throw new BetEventValidationError(
          `Unsupported routing key: ${routingKey}`,
        );
      }
      const rawEvent = message.content.toString();
      if (
        message.content.length >
        this.config.getOrThrow<number>("security.maxEventBytes")
      ) {
        throw new BetEventValidationError("Event payload is too large");
      }
      this.signer.verify(routingKey, rawEvent, message.properties.headers);
      const event = await validateBetEvent(parseBetEventJson(rawEvent));
      const eventId = this.signer.eventId(message.properties.headers);
      await this.betProcessing.process(routingKey, event, eventId, rawEvent);
      channel.ack(message);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        error instanceof BetEventValidationError ||
        error instanceof UnsupportedCurrencyError ||
        error instanceof MessageAuthenticationError ||
        error instanceof BetPayloadConflictError ||
        error instanceof EventPayloadConflictError
      ) {
        this.logger.warn(
          error instanceof SyntaxError
            ? "Dead-lettering invalid JSON"
            : `Dead-lettering invalid message: ${String(error)}`,
        );
        channel.nack(message, false, false);
        return;
      }

      const retries = Number(
        message.properties.headers?.["x-retry-count"] ?? 0,
      );
      if (!Number.isSafeInteger(retries) || retries < 0) {
        channel.nack(message, false, false);
        return;
      }
      const maxRetries = this.config.getOrThrow<number>("rabbitmq.maxRetries");
      if (retries >= maxRetries) {
        this.logger.error(
          `Dead-lettering after ${retries} retries: ${String(error)}`,
        );
        channel.nack(message, false, false);
        return;
      }
      if (this.stopping) {
        channel.nack(message, false, true);
        return;
      }

      try {
        await this.publishRetry(channel, message, routingKey, retries + 1);
        channel.ack(message);
      } catch (publishError) {
        this.logger.error(`Retry publish failed: ${String(publishError)}`);
        channel.nack(message, false, true);
      }
    }
  }

  private async publishRetry(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    routingKey: string,
    retries: number,
  ): Promise<void> {
    const exchange = this.config.getOrThrow<string>("rabbitmq.exchange");
    await publishMandatory(
      channel,
      `${exchange}.retry`,
      routingKey,
      message.content,
      {
        contentType: message.properties.contentType ?? "application/json",
        messageId: message.properties.messageId,
        persistent: true,
        headers: {
          ...message.properties.headers,
          "x-retry-count": retries,
        },
      },
      this.config.getOrThrow<number>("rabbitmq.publishConfirmTimeoutMs"),
    );
  }
}
