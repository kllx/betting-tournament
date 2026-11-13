import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import amqp, { Channel, ChannelModel } from "amqplib";
import request from "supertest";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { signBetEvent, testEventSigningSecret } from "./sign-event";
import { createTestDataSource, testDatabaseUrl } from "./test-database";

describe("Observability", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_EXCHANGE = `observability.test.${process.pid}`;
    process.env.RABBITMQ_QUEUE = `observability.queue.${process.pid}`;
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
  });

  afterAll(async () => {
    await app?.close();
    await channel?.close();
    await connection?.close();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("exposes health and processing metrics", async () => {
    await request(app.getHttpServer()).get("/health/ready").expect(200);
    const event = {
      betId: "metrics-bet",
      playerId: "metrics-player",
      currency: "USD",
      stake: 1,
      winAmount: 1,
      settledAt: "2026-11-12T10:00:00.000Z",
    };
    channel.publish(
      process.env.RABBITMQ_EXCHANGE!,
      "bet.settled",
      Buffer.from(JSON.stringify(event)),
      { persistent: true, ...signBetEvent("bet.settled", event) },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const response = await request(app.getHttpServer())
      .get("/metrics")
      .expect(200);
    expect(response.text).toContain(
      'bet_events_total{event_type="bet.settled",result="processed"} 1',
    );
    expect(response.text).toContain("fingerprint_duration_ms_count");
    expect(response.text).toContain("http_requests_total");
  });
});
