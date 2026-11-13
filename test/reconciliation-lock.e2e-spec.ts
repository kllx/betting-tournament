import Redis from "ioredis";
import { ReconciliationLock } from "../src/leaderboard/reconciliation-lock";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ReconciliationLock", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis("redis://localhost:56379/7");
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("rejects batch operations after ownership changes", async () => {
    const lock = new ReconciliationLock(redis);
    await lock.acquire();
    await redis.set(ReconciliationLock.key, "another-owner", "PX", 30000);

    await expect(lock.assertOwnership()).rejects.toThrow(
      "Reconciliation lock lost",
    );
    await lock.release();
    await redis.del(ReconciliationLock.key);
  });

  it("does not extend a lock acquired by another owner", async () => {
    const lock = new ReconciliationLock(redis, 80, 20);
    await lock.acquire();
    await redis.set(ReconciliationLock.key, "another-owner", "PX", 40);

    await delay(120);

    await expect(redis.get(ReconciliationLock.key)).resolves.toBeNull();
    await lock.release();
  });
});
