import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ChannelModel, ConfirmChannel, connect } from "amqplib";
import { DataSource } from "typeorm";
import { BetEvent } from "../src/bets/bet-event";
import { publishMandatory } from "../src/messaging/publish-mandatory";
import { EventSigner } from "../src/security/event-signer";
import configuration from "../src/config/configuration";
import { TokenBucket } from "../src/utils/token-bucket";
import { createTestDataSource } from "../test/test-database";

interface LoadOptions {
  rate: number;
  durationSeconds: number;
  players: number;
  batchSize: number;
  drainTimeoutMs: number;
}

function parseOptions(): LoadOptions {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: number): number => {
    const index = args.indexOf(name);
    const parsed = index >= 0 ? Number(args[index + 1]) : fallback;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
  };
  return {
    rate: value("--rate", 5000),
    durationSeconds: value("--duration", 10),
    players: value("--players", 1000000),
    batchSize: value("--batch-size", 100),
    drainTimeoutMs: value("--drain-timeout", 30000),
  };
}

function percentile(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))
    ] ?? 0
  );
}

async function seedPlayers(
  dataSource: DataSource,
  players: number,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO players (player_id, points, points_reached_at, score_version)
     SELECT $1 || g, (g % 1000) + 1, now(), nextval('tournament_score_version_seq')
     FROM generate_series(1, $2) AS g`,
    ["player-", players],
  );
}

interface ProcessedResult {
  processed: number;
  invalid: number;
}

async function waitForProcessed(
  dataSource: DataSource,
  target: number,
  timeoutMs: number,
): Promise<ProcessedResult> {
  const query = `
    SELECT
      count(*) FILTER (WHERE status = 'processed')::int AS processed,
      count(*) FILTER (WHERE status IN ('ignored', 'duplicate'))::int AS invalid
    FROM bet_events
  `;
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const result = await dataSource.query(query);
    if (Number(result[0].processed) >= target) {
      return {
        processed: Number(result[0].processed),
        invalid: Number(result[0].invalid),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const result = await dataSource.query(query);
  return {
    processed: Number(result[0].processed),
    invalid: Number(result[0].invalid),
  };
}

async function publishBatch(
  channel: ConfirmChannel,
  exchange: string,
  signer: EventSigner,
  start: number,
  end: number,
  players: number,
  latencies: number[],
  publishConfirmTimeoutMs: number,
): Promise<void> {
  const events: BetEvent[] = [];
  for (let index = start; index < end; index += 1) {
    events.push({
      betId: `load-bet-${index}`,
      playerId: `player-${index % players}`,
      currency: "USD",
      stake: 1,
      winAmount: 1,
      settledAt: "2026-11-12T10:00:00.000Z",
    });
  }
  await Promise.all(
    events.map(async (event) => {
      const eventId = randomUUID();
      const body = JSON.stringify(event);
      const started = performance.now();
      await publishMandatory(
        channel,
        exchange,
        "bet.settled",
        Buffer.from(body),
        {
          contentType: "application/json",
          messageId: eventId,
          persistent: true,
          headers: signer.sign("bet.settled", body, eventId),
        },
        publishConfirmTimeoutMs,
      );
      latencies.push(performance.now() - started);
    }),
  );
}

async function main(): Promise<void> {
  const options = parseOptions();
  const config = configuration();
  const dataSource = await createTestDataSource();
  await seedPlayers(dataSource, options.players);

  const exchange = process.env.RABBITMQ_EXCHANGE ?? "load.test";
  const signer = new EventSigner(
    process.env.EVENT_SIGNING_SECRET ??
      "local-external-event-signing-secret-32",
    "bet-event-v1",
  );
  let connection: ChannelModel | undefined;
  let channel: ConfirmChannel | undefined;
  try {
    connection = await connect(
      process.env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672",
    );
    channel = await connection.createConfirmChannel();
    await channel.assertExchange(exchange, "topic", { durable: true });

    const target = options.rate * options.durationSeconds;
    const latencies: number[] = [];
    const bucket = new TokenBucket(options.rate, options.batchSize, () =>
      performance.now(),
    );
    const started = performance.now();
    let published = 0;
    while (published < target) {
      const end = Math.min(target, published + options.batchSize);
      const delay = bucket.consume(end - published);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await publishBatch(
        channel,
        exchange,
        signer,
        published,
        end,
        options.players,
        latencies,
        config.rabbitmq.publishConfirmTimeoutMs,
      );
      published = end;
    }
    const publishDurationMs = performance.now() - started;
    const { processed, invalid } = await waitForProcessed(
      dataSource,
      target,
      options.drainTimeoutMs,
    );
    const totalDurationMs = performance.now() - started;

    process.stdout.write(
      `${JSON.stringify({
        target,
        published,
        processed,
        invalid,
        players: options.players,
        publishDurationMs: Math.round(publishDurationMs),
        totalDurationMs: Math.round(totalDurationMs),
        publishRps: Math.round(published / (publishDurationMs / 1000)),
        processedRps: Math.round(processed / (totalDurationMs / 1000)),
        remaining: target - processed,
        publishLatencyMs: {
          p50: Number(percentile(latencies, 0.5).toFixed(2)),
          p95: Number(percentile(latencies, 0.95).toFixed(2)),
          p99: Number(percentile(latencies, 0.99).toFixed(2)),
        },
      })}\n`,
    );
    if (processed < target || invalid > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (channel) {
      await channel.close().catch(() => undefined);
    }
    if (connection) {
      await connection.close().catch(() => undefined);
    }
    await dataSource.destroy().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
