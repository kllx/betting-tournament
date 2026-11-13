import Redis from "ioredis";
import { ReconciliationLock } from "./reconciliation-lock";

describe("ReconciliationLock", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renews the lock while work is in progress and stops after release", async () => {
    const evaluate = jest.fn().mockResolvedValue(1);
    const redis = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: evaluate,
    } as unknown as Redis;
    const lock = new ReconciliationLock(redis);

    await lock.acquire();
    await jest.advanceTimersByTimeAsync(20000);
    expect(evaluate).toHaveBeenCalledTimes(2);

    await lock.release();
    await jest.advanceTimersByTimeAsync(10000);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("does not renew a lock owned by another worker", async () => {
    const evaluate = jest.fn();
    const redis = {
      set: jest.fn().mockResolvedValue(null),
      eval: evaluate,
    } as unknown as Redis;
    const lock = new ReconciliationLock(redis);

    await lock.acquire();
    await jest.advanceTimersByTimeAsync(20000);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
