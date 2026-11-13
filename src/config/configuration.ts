import { Money, preserveJsonNumbers } from "../money";
import { LIMITS } from "./limits";

function readInt(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} is outside the allowed range`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw !== "true" && raw !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return raw === "true";
}

function readSecret(name: string, localDefault: string): string {
  const value = process.env[name] ?? localDefault;
  if (
    process.env.NODE_ENV === "production" &&
    (value.length < 32 || value.startsWith("local-"))
  ) {
    throw new Error(
      `${name} must be explicitly configured with at least 32 characters`,
    );
  }
  return value;
}

function parseConnectionUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
}

function readRabbitMqUrl(): string {
  const value = process.env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672";
  const url = parseConnectionUrl("RABBITMQ_URL", value);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (
    process.env.NODE_ENV === "production" &&
    username === "guest" &&
    password === "guest"
  ) {
    throw new Error("RABBITMQ_URL must not use default guest credentials");
  }
  return value;
}

function readDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (process.env.NODE_ENV === "production") {
    if (!value) {
      throw new Error(
        "DATABASE_URL must be explicitly configured in production",
      );
    }
    const url = parseConnectionUrl("DATABASE_URL", value);
    const username = decodeURIComponent(
      url.searchParams.get("user") ?? url.username,
    );
    const password = decodeURIComponent(
      url.searchParams.get("password") ?? url.password,
    );
    if (username === "postgres" && password === "postgres") {
      throw new Error("DATABASE_URL must not use default postgres credentials");
    }
  }
  return (
    value ?? "postgresql://postgres:postgres@localhost:55432/betting_tournament"
  );
}

function parseFxRates(raw: string): Record<string, Money> {
  const rates = JSON.parse(preserveJsonNumbers(raw)) as Record<string, unknown>;
  if (rates === null || Array.isArray(rates) || typeof rates !== "object") {
    throw new Error("FX_RATES must be a JSON object");
  }
  const result: Record<string, Money> = {};
  for (const [currency, rate] of Object.entries(rates)) {
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      (typeof rate !== "number" && typeof rate !== "string")
    ) {
      throw new Error(`Invalid FX rate for ${currency}`);
    }
    try {
      const money = Money.from(rate);
      if (!money.isPositive() || money.gt(LIMITS.MAX_FX_RATE)) {
        throw new Error(`Invalid FX rate for ${currency}`);
      }
      result[currency] = money;
    } catch {
      throw new Error(`Invalid FX rate for ${currency}`);
    }
  }
  return result;
}

function parsePrizes(raw: string): Money[] {
  const prizes = JSON.parse(preserveJsonNumbers(raw)) as unknown;
  if (!Array.isArray(prizes) || prizes.length > LIMITS.MAX_PRIZES) {
    throw new Error("TOURNAMENT_PRIZES contains invalid values");
  }
  return prizes.map((prize) => {
    if (typeof prize !== "number" && typeof prize !== "string") {
      throw new Error("TOURNAMENT_PRIZES contains invalid values");
    }
    try {
      const money = Money.from(prize);
      if (!money.isPositive() || money.gt(LIMITS.MAX_PRIZE_AMOUNT)) {
        throw new Error("TOURNAMENT_PRIZES contains invalid values");
      }
      return money;
    } catch {
      throw new Error("TOURNAMENT_PRIZES contains invalid values");
    }
  });
}

export default () => {
  const settlementGraceMs = readInt(
    "TOURNAMENT_SETTLEMENT_GRACE_MS",
    600000,
    0,
  );
  const finalizeAfterMs = readInt("TOURNAMENT_FINALIZE_AFTER_MS", 900000, 0);
  if (finalizeAfterMs < settlementGraceMs) {
    throw new Error(
      "TOURNAMENT_FINALIZE_AFTER_MS must be greater than or equal to TOURNAMENT_SETTLEMENT_GRACE_MS",
    );
  }
  const endsAt = process.env.TOURNAMENT_END_AT ?? "2099-12-31T23:59:59.000Z";
  if (!Number.isFinite(Date.parse(endsAt))) {
    throw new Error("TOURNAMENT_END_AT must be a valid ISO date");
  }

  return {
    port: readInt("PORT", 3000),
    trustProxy: readInt("TRUST_PROXY", 0, 0),
    databaseUrl: readDatabaseUrl(),
    databaseMigrationsRun: readBoolean(
      "DATABASE_MIGRATIONS_RUN",
      process.env.NODE_ENV !== "production",
    ),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:56379",
    redis: {
      maxRetriesPerRequest: readInt("REDIS_MAX_RETRIES_PER_REQUEST", 3),
      commandTimeoutMs: readInt("REDIS_COMMAND_TIMEOUT_MS", 1000),
      connectTimeoutMs: readInt("REDIS_CONNECT_TIMEOUT_MS", 5000),
    },
    adminApiToken: readSecret("ADMIN_API_TOKEN", "local-admin-token"),
    security: {
      eventSigningSecret: readSecret(
        "EVENT_SIGNING_SECRET",
        "local-external-event-signing-secret-32",
      ),
      internalSigningSecret: readSecret(
        "INTERNAL_EVENT_SIGNING_SECRET",
        "local-internal-event-signing-secret-32",
      ),
      maxWinAmountUsd: readInt(
        "MAX_WIN_AMOUNT_USD",
        LIMITS.DEFAULT_MAX_WIN_AMOUNT_USD,
      ),
      maxEventBytes: readInt("MAX_EVENT_BYTES", LIMITS.DEFAULT_MAX_EVENT_BYTES),
    },
    rateLimit: {
      adminWindowMs: readInt("RATE_LIMIT_ADMIN_WINDOW_MS", 60000),
      adminMaxRequests: readInt("RATE_LIMIT_ADMIN_MAX_REQUESTS", 30),
      leaderboardWindowMs: readInt("RATE_LIMIT_LEADERBOARD_WINDOW_MS", 1000),
      leaderboardMaxRequests: readInt(
        "RATE_LIMIT_LEADERBOARD_MAX_REQUESTS",
        1000,
      ),
      postgresFallbackWindowMs: readInt(
        "RATE_LIMIT_POSTGRES_FALLBACK_WINDOW_MS",
        1000,
      ),
      postgresFallbackMaxRequests: readInt(
        "RATE_LIMIT_POSTGRES_FALLBACK_MAX_REQUESTS",
        100,
      ),
    },
    rabbitmq: {
      url: readRabbitMqUrl(),
      exchange: process.env.RABBITMQ_EXCHANGE ?? "betting",
      queue: process.env.RABBITMQ_QUEUE ?? "tournament.bets",
      prefetch: readInt("RABBITMQ_PREFETCH", 20),
      retryTtlMs: readInt("RABBITMQ_RETRY_TTL_MS", 1000),
      maxRetries: readInt("RABBITMQ_MAX_RETRIES", 3, 0),
      publishConfirmTimeoutMs: readInt(
        "RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS",
        5000,
      ),
    },
    shutdown: {
      gracePeriodMs: readInt("SHUTDOWN_GRACE_PERIOD_MS", 5000),
      connectionCheckIntervalMs: readInt(
        "SHUTDOWN_CONNECTION_CHECK_INTERVAL_MS",
        100,
      ),
      workerDrainTimeoutMs: readInt("SHUTDOWN_WORKER_DRAIN_TIMEOUT_MS", 5000),
      rabbitmqReconnectDelayMs: readInt("RABBITMQ_RECONNECT_DELAY_MS", 1000),
    },
    outbox: {
      batchSize: readInt("OUTBOX_BATCH_SIZE", 100),
      pollIntervalMs: readInt("OUTBOX_POLL_INTERVAL_MS", 100),
      publishConcurrency: readInt("OUTBOX_PUBLISH_CONCURRENCY", 10),
      maxAttempts: readInt("OUTBOX_MAX_ATTEMPTS", 5),
    },
    retention: {
      outboxDays: readInt("OUTBOX_RETENTION_DAYS", 7),
      betEventsDays: readInt("BET_EVENTS_RETENTION_DAYS", 30),
      betEventIdsDays: readInt("BET_EVENT_IDS_RETENTION_DAYS", 90),
      betEventIdsArchiveDays: readInt(
        "BET_EVENT_IDS_ARCHIVE_RETENTION_DAYS",
        365,
      ),
      batchSize: readInt("RETENTION_BATCH_SIZE", 10000),
      cleanupIntervalMs: readInt("RETENTION_CLEANUP_INTERVAL_MS", 3600000),
    },
    leaderboard: {
      reconcileIntervalMs: readInt("LEADERBOARD_RECONCILE_INTERVAL_MS", 60000),
      activePhaseTtlMs: readInt("LEADERBOARD_ACTIVE_PHASE_TTL_MS", 1000),
      readyWaitMs: readInt("LEADERBOARD_READY_WAIT_MS", 30000),
    },
    tournament: {
      endsAt,
      settlementGraceMs,
      finalizeAfterMs,
      finalizerIntervalMs: readInt("TOURNAMENT_FINALIZER_INTERVAL_MS", 1000),
      prizes: parsePrizes(process.env.TOURNAMENT_PRIZES ?? "[1000,500,250]"),
    },
    fxRates: parseFxRates(
      process.env.FX_RATES ?? '{"USD":1,"EUR":1.1,"RUB":0.011}',
    ),
  };
};
