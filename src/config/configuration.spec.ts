import configuration from "./configuration";

const keys = [
  "NODE_ENV",
  "ADMIN_API_TOKEN",
  "EVENT_SIGNING_SECRET",
  "INTERNAL_EVENT_SIGNING_SECRET",
  "RABBITMQ_URL",
  "DATABASE_URL",
  "MAX_EVENT_BYTES",
  "TOURNAMENT_SETTLEMENT_GRACE_MS",
  "TOURNAMENT_FINALIZE_AFTER_MS",
  "TOURNAMENT_PRIZES",
  "FX_RATES",
] as const;

describe("production security configuration", () => {
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("rejects the local admin token in production", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:password@postgres:5432/app";
    delete process.env.ADMIN_API_TOKEN;

    expect(() => configuration()).toThrow("ADMIN_API_TOKEN");
  });

  it("rejects non-numeric security limits", () => {
    process.env.MAX_EVENT_BYTES = "100junk";

    expect(() => configuration()).toThrow("MAX_EVENT_BYTES");
  });

  it("rejects finalization before the settlement cutoff", () => {
    process.env.TOURNAMENT_SETTLEMENT_GRACE_MS = "600000";
    process.env.TOURNAMENT_FINALIZE_AFTER_MS = "1000";

    expect(() => configuration()).toThrow("TOURNAMENT_FINALIZE_AFTER_MS");
  });

  it("requires an explicit production database URL", () => {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_API_TOKEN = "production-admin-token-with-32-characters";
    process.env.EVENT_SIGNING_SECRET =
      "production-external-secret-with-32-characters";
    process.env.INTERNAL_EVENT_SIGNING_SECRET =
      "production-internal-secret-with-32-characters";
    process.env.RABBITMQ_URL = "amqp://user:password@rabbitmq:5672";
    delete process.env.DATABASE_URL;

    expect(() => configuration()).toThrow("DATABASE_URL");
  });

  it("rejects percent-encoded default RabbitMQ credentials", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:password@postgres:5432/app";
    process.env.ADMIN_API_TOKEN = "production-admin-token-with-32-characters";
    process.env.EVENT_SIGNING_SECRET =
      "production-external-secret-with-32-characters";
    process.env.INTERNAL_EVENT_SIGNING_SECRET =
      "production-internal-secret-with-32-characters";
    process.env.RABBITMQ_URL = "amqp://%67uest:%67uest@rabbitmq:5672";

    expect(() => configuration()).toThrow("RABBITMQ_URL");
  });

  it("rejects default PostgreSQL credentials through query parameters", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL =
      "postgresql://user:password@postgres:5432/app?user=postgres&password=postgres";
    process.env.ADMIN_API_TOKEN = "production-admin-token-with-32-characters";
    process.env.EVENT_SIGNING_SECRET =
      "production-external-secret-with-32-characters";
    process.env.INTERNAL_EVENT_SIGNING_SECRET =
      "production-internal-secret-with-32-characters";
    process.env.RABBITMQ_URL = "amqp://user:password@rabbitmq:5672";

    expect(() => configuration()).toThrow("DATABASE_URL");
  });

  it("does not expose connection credentials in invalid URL errors", () => {
    process.env.RABBITMQ_URL = "amqp://user:secret-password@bad url";

    expect(() => configuration()).toThrow("RABBITMQ_URL");
    expect(() => configuration()).not.toThrow("secret-password");
  });

  it("rejects default RabbitMQ guest credentials in production", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://user:password@postgres:5432/app";
    process.env.ADMIN_API_TOKEN = "production-admin-token-with-32-characters";
    process.env.EVENT_SIGNING_SECRET =
      "production-external-secret-with-32-characters";
    process.env.INTERNAL_EVENT_SIGNING_SECRET =
      "production-internal-secret-with-32-characters";
    delete process.env.RABBITMQ_URL;

    expect(() => configuration()).toThrow("RABBITMQ_URL");
  });

  it("preserves exact monetary literals in FX rates and prizes", () => {
    process.env.FX_RATES = '{"EUR":0.100000000000000001}';
    process.env.TOURNAMENT_PRIZES = "[1000.000000000000000001]";

    const config = configuration();

    expect(config.fxRates.EUR.toString()).toBe("0.100000000000000001");
    expect(config.tournament.prizes[0].toString()).toBe(
      "1000.000000000000000001",
    );
  });
});
