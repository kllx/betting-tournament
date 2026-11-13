import { INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import amqp, { Channel, ChannelModel, GetMessage } from "amqplib";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { signBetEvent, testEventSigningSecret } from "./sign-event";
import { createTestDataSource, testDatabaseUrl } from "./test-database";

const exchange = `retry.test.${process.pid}`;
const queue = `retry.queue.${process.pid}`;

describe("RabbitMQ delayed retries", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    Logger.overrideLogger([]);
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_EXCHANGE = exchange;
    process.env.RABBITMQ_QUEUE = queue;
    process.env.RABBITMQ_RETRY_TTL_MS = "50";
    process.env.RABBITMQ_MAX_RETRIES = "2";
    process.env.REDIS_URL = "redis://localhost:56379/4";
    process.env.EVENT_SIGNING_SECRET = testEventSigningSecret;
    dataSource = await createTestDataSource();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BetProcessingService)
      .useValue({
        process: jest.fn().mockRejectedValue(new Error("database down")),
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    connection = await amqp.connect("amqp://guest:guest@localhost:5672");
    channel = await connection.createChannel();
    await channel.assertExchange(exchange, "topic", { durable: true });
    const event = {
      betId: "retry-bet",
      playerId: "retry-player",
      currency: "USD",
      stake: 1,
      winAmount: 1,
      settledAt: "2026-11-12T10:00:00.000Z",
    };
    channel.publish(
      exchange,
      "bet.settled",
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        ...signBetEvent("bet.settled", event),
      },
    );
  });

  afterAll(async () => {
    await app?.close();
    if (channel) {
      for (const name of [
        queue,
        `${queue}.dlq`,
        `${queue}.retry.settled`,
        `${queue}.retry.rollback`,
        `${queue}.payouts`,
        `${queue}.leaderboard`,
      ]) {
        await channel.deleteQueue(name).catch(() => undefined);
      }
      for (const name of [exchange, `${exchange}.dlx`, `${exchange}.retry`]) {
        await channel.deleteExchange(name).catch(() => undefined);
      }
      await channel.close();
    }
    await connection?.close();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    Logger.overrideLogger(["log", "error", "warn"]);
  });

  it("dead-letters a transient failure after the configured attempts", async () => {
    let message: false | GetMessage = false;
    for (let attempt = 0; attempt < 50 && message === false; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      message = await channel.get(`${queue}.dlq`);
    }

    expect(message).not.toBe(false);
    if (message) {
      expect(message.properties.headers?.["x-retry-count"]).toBe(2);
      channel.ack(message);
    }
  }, 15000);

  it("dead-letters invalid retry metadata", async () => {
    const event = {
      betId: "invalid-retry-bet",
      playerId: "invalid-retry-player",
      currency: "USD",
      stake: 1,
      winAmount: 1,
      settledAt: "2026-11-12T10:00:00.000Z",
    };
    channel.publish(
      exchange,
      "bet.settled",
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        headers: {
          ...signBetEvent("bet.settled", event).headers,
          "x-retry-count": "bad",
        },
      },
    );

    let message: false | GetMessage = false;
    for (let attempt = 0; attempt < 50 && message === false; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      message = await channel.get(`${queue}.dlq`);
    }
    expect(message).not.toBe(false);
    if (message) {
      channel.ack(message);
    }
  }, 15000);
});
