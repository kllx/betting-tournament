import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { createTestDataSource, testDatabaseUrl } from "./test-database";

describe("Admin rate limit scope", () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_EXCHANGE = `admin.rate.test.${process.pid}`;
    process.env.RABBITMQ_QUEUE = `admin.rate.queue.${process.pid}`;
    process.env.REDIS_URL = "redis://localhost:56379/5";
    process.env.TOURNAMENT_END_AT = "2099-12-31T23:59:59.000Z";
    process.env.ADMIN_API_TOKEN = "test-admin-token";
    process.env.RATE_LIMIT_ADMIN_WINDOW_MS = "60000";
    process.env.RATE_LIMIT_ADMIN_MAX_REQUESTS = "1";
    dataSource = await createTestDataSource();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("applies the admin bucket to case-variant routes", async () => {
    await request(app.getHttpServer())
      .post("/ADMIN/tournament/finalize")
      .set("X-Admin-Token", "test-admin-token")
      .expect(200);
    await request(app.getHttpServer())
      .post("/ADMIN/tournament/finalize")
      .set("X-Admin-Token", "test-admin-token")
      .expect(429);
  });
});
