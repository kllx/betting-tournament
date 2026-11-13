import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import request from "supertest";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import {
  createTestDataSource,
  resetTestDataSource,
  testDatabaseUrl,
} from "./test-database";

const exchange = `tournament.http.${process.pid}`;
const queue = `tournament.http.queue.${process.pid}`;

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

describe("Tournament administration and payouts", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_EXCHANGE = exchange;
    process.env.RABBITMQ_QUEUE = queue;
    process.env.REDIS_URL = "redis://localhost:56379/3";
    process.env.TOURNAMENT_END_AT = "2099-12-31T23:59:59.000Z";
    process.env.TOURNAMENT_PRIZES = "[100,50]";
    process.env.ADMIN_API_TOKEN = "test-admin-token";
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";

    dataSource = await createTestDataSource();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    redis = new Redis(process.env.REDIS_URL);
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at) VALUES
      ('alice', 100, '2026-11-12T10:02:00Z'),
      ('bob', 100, '2026-11-12T10:01:00Z'),
      ('carol', 150, '2026-11-12T10:03:00Z')
    `);
    await dataSource.query(`
      UPDATE tournament_state SET
        ends_at = now() - interval '16 minutes',
        settlement_cutoff_at = now() - interval '6 minutes',
        finalize_at = now() - interval '1 minute'
    `);
  });

  afterAll(async () => {
    await app?.close();
    await redis?.flushdb();
    await redis?.quit();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("finalizes once and pays every winner through RabbitMQ", async () => {
    await request(app.getHttpServer())
      .post("/admin/tournament/finalize")
      .set("X-Admin-Token", "wrong")
      .expect(401);

    await request(app.getHttpServer())
      .post("/admin/tournament/finalize")
      .set("X-Admin-Token", "test-admin-token")
      .expect(200, { finalized: true, phase: "PAYING" });

    await waitFor(async () => {
      const payouts = await dataSource.query(
        "SELECT status FROM payouts ORDER BY rank",
      );
      expect(payouts).toEqual([{ status: "PAID" }, { status: "PAID" }]);
      const state = await dataSource.query(
        "SELECT phase FROM tournament_state WHERE id = 1",
      );
      expect(state).toEqual([{ phase: "PAID" }]);
    });

    await request(app.getHttpServer())
      .post("/admin/tournament/finalize")
      .set("X-Admin-Token", "test-admin-token")
      .expect(200, { finalized: true, phase: "PAID" });

    const winners = await dataSource.query(
      "SELECT player_id FROM tournament_winners ORDER BY rank",
    );
    const payouts = await dataSource.query("SELECT * FROM payouts");
    const outbox = await dataSource.query("SELECT status FROM outbox");
    expect(winners).toEqual([{ player_id: "carol" }, { player_id: "bob" }]);
    expect(payouts).toHaveLength(2);
    expect(outbox.every((row: any) => row.status === "PUBLISHED")).toBe(true);

    const leaderboard = await request(app.getHttpServer())
      .get("/leaderboard")
      .set("X-Player-Id", "alice")
      .expect(200);
    expect(leaderboard.body.player).toEqual({
      rank: 3,
      playerId: "alice",
      points: 100,
    });
  });
});
