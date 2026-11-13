import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import amqp, { Channel, ChannelModel } from "amqplib";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { RabbitMqConsumer } from "../src/bets/rabbitmq.consumer";
import { signBetEvent, testEventSigningSecret } from "./sign-event";
import {
  createTestDataSource,
  resetTestDataSource,
  testDatabaseUrl,
} from "./test-database";

const exchange = `reconnect.test.${process.pid}`;
const queue = `reconnect.queue.${process.pid}`;

describe("RabbitMQ reconnect", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_EXCHANGE = exchange;
    process.env.RABBITMQ_QUEUE = queue;
    process.env.RABBITMQ_RECONNECT_DELAY_MS = "50";
    process.env.REDIS_URL = "redis://localhost:56379/5";
    process.env.TOURNAMENT_END_AT = "2099-12-31T23:59:59.000Z";
    process.env.EVENT_SIGNING_SECRET = testEventSigningSecret;
    dataSource = await createTestDataSource();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    connection = await amqp.connect("amqp://guest:guest@localhost:5672");
    channel = await connection.createChannel();
    await channel.assertExchange(exchange, "topic", { durable: true });
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
  });

  afterAll(async () => {
    await app?.close();
    await channel?.close();
    await connection?.close();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("resumes processing after the broker connection closes", async () => {
    const event = {
      betId: "reconnect-bet",
      playerId: "reconnect-player",
      currency: "USD",
      stake: 1,
      winAmount: 1,
      settledAt: "2026-11-12T10:00:00.000Z",
    };
    channel.publish(
      exchange,
      "bet.settled",
      Buffer.from(JSON.stringify(event)),
      { persistent: true, ...signBetEvent("bet.settled", event) },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const consumer = app.get(RabbitMqConsumer);
    await (consumer as any).connection.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    channel.publish(
      exchange,
      "bet.settled",
      Buffer.from(JSON.stringify(event)),
      { persistent: true, ...signBetEvent("bet.settled", event) },
    );

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 1 }]);
  });
});
