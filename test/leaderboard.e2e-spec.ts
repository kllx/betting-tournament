import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import request from "supertest";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { LeaderboardProjection } from "../src/leaderboard/leaderboard.projection";
import {
  createTestDataSource,
  resetTestDataSource,
  testDatabaseUrl,
} from "./test-database";

const exchange = `leaderboard.test.${process.pid}`;
const queue = `leaderboard.queue.test.${process.pid}`;

describe("GET /leaderboard", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_EXCHANGE = exchange;
    process.env.RABBITMQ_QUEUE = queue;
    process.env.REDIS_URL = "redis://localhost:56379/2";
    process.env.TOURNAMENT_END_AT = "2099-12-31T23:59:59.000Z";
    process.env.FX_RATES = '{"USD":1,"EUR":1.1}';

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
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("returns sorted leaders and the requested player position", async () => {
    await dataSource.query(
      `INSERT INTO players (player_id, points) VALUES
       ('alice', 100), ('bob', 200), ('carol', 150)`,
    );
    await app.get(LeaderboardProjection).rebuild();

    const response = await request(app.getHttpServer())
      .get("/leaderboard")
      .set("X-Player-Id", "carol")
      .expect(200);

    expect(response.body).toEqual({
      top: [
        { rank: 1, playerId: "bob", points: 200 },
        { rank: 2, playerId: "carol", points: 150 },
        { rank: 3, playerId: "alice", points: 100 },
      ],
      player: { rank: 2, playerId: "carol", points: 150 },
    });
  });

  it("limits the top to 100 and finds a player below it", async () => {
    const values = Array.from(
      { length: 105 },
      (_, index) => `('player-${index + 1}', ${105 - index})`,
    ).join(",");
    await dataSource.query(
      `INSERT INTO players (player_id, points) VALUES ${values}`,
    );
    await app.get(LeaderboardProjection).rebuild();

    const response = await request(app.getHttpServer())
      .get("/leaderboard")
      .set("X-Player-Id", "player-105")
      .expect(200);

    expect(response.body.top).toHaveLength(100);
    expect(response.body.top[99]).toEqual({
      rank: 100,
      playerId: "player-100",
      points: 6,
    });
    expect(response.body.player).toEqual({
      rank: 105,
      playerId: "player-105",
      points: 1,
    });
  });

  it("returns null for a player without settled bets", async () => {
    const response = await request(app.getHttpServer())
      .get("/leaderboard")
      .set("X-Player-Id", "unknown")
      .expect(200);

    expect(response.body).toEqual({ top: [], player: null });
  });

  it("rejects a request without X-Player-Id", async () => {
    await request(app.getHttpServer()).get("/leaderboard").expect(400);
  });
});
