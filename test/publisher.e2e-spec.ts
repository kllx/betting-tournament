import { ConfigService } from "@nestjs/config";
import { RabbitMqPublisher } from "../src/outbox/rabbitmq.publisher";

describe("RabbitMQ mandatory publishing", () => {
  it("rejects an unroutable message instead of confirming its publication", async () => {
    const values: Record<string, unknown> = {
      "rabbitmq.url": "amqp://guest:guest@localhost:5672",
      "rabbitmq.exchange": `unroutable.test.${process.pid}`,
      "security.internalSigningSecret": "test-internal-signing-secret",
      "rabbitmq.publishConfirmTimeoutMs": 5000,
    };
    const config = {
      getOrThrow: (key: string) => {
        if (!(key in values)) {
          throw new Error(`Missing config ${key}`);
        }
        return values[key];
      },
    } as ConfigService;
    const publisher = new RabbitMqPublisher(config);
    await publisher.onModuleInit();
    try {
      await expect(
        publisher.publish("missing.binding", { ok: true }, "missing-1"),
      ).rejects.toThrow("Unroutable message");
    } finally {
      await publisher.close();
    }
  });

  it("shares one return listener across concurrent publications", async () => {
    const values: Record<string, unknown> = {
      "rabbitmq.url": "amqp://guest:guest@localhost:5672",
      "rabbitmq.exchange": `unroutable.concurrent.test.${process.pid}`,
      "security.internalSigningSecret": "test-internal-signing-secret",
      "rabbitmq.publishConfirmTimeoutMs": 5000,
    };
    const config = {
      getOrThrow: (key: string) => values[key],
    } as ConfigService;
    const publisher = new RabbitMqPublisher(config);
    await publisher.onModuleInit();
    let maxListeners = 0;
    let finished = false;
    try {
      const publishing = Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          publisher
            .publish("missing.binding", { index }, `missing-${index}`)
            .catch(() => undefined),
        ),
      ).then(() => {
        finished = true;
      });
      const watching = (async () => {
        while (!finished) {
          maxListeners = Math.max(
            maxListeners,
            (publisher as any).channel.listenerCount("return"),
          );
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      await Promise.all([publishing, watching]);
      expect(maxListeners).toBe(1);
    } finally {
      await publisher.close();
    }
  });
});
