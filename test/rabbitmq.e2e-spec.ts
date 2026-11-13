import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import amqp, { Channel, ChannelModel } from "amqplib";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import {
  signBetEvent,
  signInternalEvent,
  testEventSigningSecret,
} from "./sign-event";
import {
  createTestDataSource,
  resetTestDataSource,
  testDatabaseUrl,
} from "./test-database";

const exchange = `betting.test.${process.pid}`;
const queue = `tournament.bets.test.${process.pid}`;

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

describe("RabbitMQ processing", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let connection: ChannelModel;
  let channel: Channel;
  let redis: Redis;

  const event = {
    betId: "rabbit-bet-1",
    playerId: "rabbit-player-1",
    currency: "EUR",
    stake: 10,
    winAmount: 25.5,
    settledAt: "2026-11-12T10:00:00.000Z",
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
    process.env.RABBITMQ_EXCHANGE = exchange;
    process.env.RABBITMQ_QUEUE = queue;
    process.env.REDIS_URL = "redis://localhost:56379/1";
    process.env.TOURNAMENT_END_AT = "2099-12-31T23:59:59.000Z";
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.EVENT_SIGNING_SECRET = testEventSigningSecret;
    process.env.FX_RATES = '{"USD":1,"EUR":1.1}';

    dataSource = await createTestDataSource();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    redis = new Redis(process.env.REDIS_URL);

    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertExchange(exchange, "topic", { durable: true });
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
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
  });

  function publish(routingKey: string, payload: unknown): void {
    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        contentType: "application/json",
        ...signBetEvent(routingKey, payload),
      },
    );
  }

  it("awards points and projects them to Redis from a bet.settled message", async () => {
    publish("bet.settled", event);

    await waitFor(async () => {
      const players = await dataSource.query(
        "SELECT points FROM players WHERE player_id = $1",
        [event.playerId],
      );
      expect(players).toEqual([{ points: 28 }]);
    });
    await waitFor(async () => {
      const leaderboard = await app
        .get(LeaderboardService)
        .getLeaderboard(event.playerId);
      expect(leaderboard.player).toEqual({
        rank: 1,
        playerId: event.playerId,
        points: 28,
      });
    });
  });

  it("removes points after a bet.rollback message", async () => {
    publish("bet.settled", event);
    await waitFor(async () => {
      const players = await dataSource.query(
        "SELECT points FROM players WHERE player_id = $1",
        [event.playerId],
      );
      expect(players).toEqual([{ points: 28 }]);
    });

    publish("bet.rollback", event);
    await waitFor(async () => {
      const players = await dataSource.query(
        "SELECT points FROM players WHERE player_id = $1",
        [event.playerId],
      );
      expect(players).toEqual([{ points: 0 }]);
    });
  });

  it("moves an invalid event to the dead-letter queue", async () => {
    publish("bet.settled", { ...event, winAmount: -1 });

    await waitFor(async () => {
      const message = await channel.get(`${queue}.dlq`);
      expect(message).not.toBe(false);
      if (message) {
        expect(JSON.parse(message.content.toString())).toMatchObject({
          betId: event.betId,
          winAmount: -1,
        });
        channel.ack(message);
      }
    });
  });

  it("dead-letters an unsigned event without awarding points", async () => {
    channel.publish(
      exchange,
      "bet.settled",
      Buffer.from(JSON.stringify({ ...event, betId: "unsigned-bet" })),
      { persistent: true },
    );

    await waitFor(async () => {
      const message = await channel.get(`${queue}.dlq`);
      expect(message).not.toBe(false);
      if (message) {
        channel.ack(message);
      }
    });
    const players = await dataSource.query("SELECT * FROM players");
    expect(players).toEqual([]);
  });

  it("does not confirm a forged payout command", async () => {
    await dataSource.query(
      `INSERT INTO payouts (player_id, idempotency_key, rank, amount, currency, status)
       VALUES ('forged', 'forged-payout', 1, 100, 'USD', 'PENDING')`,
    );
    await dataSource.query("UPDATE tournament_state SET phase = 'PAYING'");
    channel.publish(
      exchange,
      "payout.requested",
      Buffer.from(JSON.stringify({ payoutId: "forged-payout" })),
      { persistent: true },
    );

    await waitFor(async () => {
      const message = await channel.get(`${queue}.dlq`);
      expect(message).not.toBe(false);
      if (message) {
        channel.ack(message);
      }
    });
    const payout = await dataSource.query(
      "SELECT status, attempts FROM payouts WHERE idempotency_key = 'forged-payout'",
    );
    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    expect(payout).toEqual([{ status: "PENDING", attempts: 0 }]);
    expect(state).toEqual([{ phase: "PAYING" }]);
  });

  it("dead-letters an unknown signed payout", async () => {
    channel.publish(
      exchange,
      "payout.requested",
      Buffer.from(JSON.stringify({ payoutId: "unknown-signed-payout" })),
      {
        persistent: true,
        ...signInternalEvent("payout.requested", {
          payoutId: "unknown-signed-payout",
        }),
      },
    );

    await waitFor(async () => {
      const message = await channel.get(`${queue}.dlq`);
      expect(message).not.toBe(false);
      if (message) {
        channel.ack(message);
      }
    });
  });

  it("dead-letters a malformed signed score projection", async () => {
    channel.publish(exchange, "player.score.changed", Buffer.from("null"), {
      persistent: true,
      ...signInternalEvent("player.score.changed", null),
    });

    await waitFor(async () => {
      const message = await channel.get(`${queue}.dlq`);
      expect(message).not.toBe(false);
      if (message) {
        channel.ack(message);
      }
    });
  });
});
