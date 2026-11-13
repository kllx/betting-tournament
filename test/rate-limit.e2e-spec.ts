import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import request from "supertest";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { createTestDataSource, testDatabaseUrl } from "./test-database";

describe("HTTP abuse protection", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_EXCHANGE = `rate.test.${process.pid}`;
    process.env.RABBITMQ_QUEUE = `rate.queue.${process.pid}`;
    process.env.REDIS_URL = "redis://localhost:56379/5";
    process.env.TOURNAMENT_END_AT = "2099-12-31T23:59:59.000Z";
    process.env.RATE_LIMIT_LEADERBOARD_WINDOW_MS = "60000";
    process.env.RATE_LIMIT_LEADERBOARD_MAX_REQUESTS = "2";
    dataSource = await createTestDataSource();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    redis = new Redis(process.env.REDIS_URL);
  });

  afterAll(async () => {
    await app?.close();
    await redis?.flushdb();
    await redis?.quit();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("rate limits repeated leaderboard requests from one client", async () => {
    await request(app.getHttpServer())
      .get("/leaderboard")
      .set("X-Player-Id", "player-1")
      .expect(200);
    await request(app.getHttpServer())
      .get("/leaderboard")
      .set("X-Player-Id", "player-1")
      .expect(200);
    await request(app.getHttpServer())
      .get("/leaderboard")
      .set("X-Player-Id", "player-1")
      .expect(429);
  });
});
