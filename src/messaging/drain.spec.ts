import { waitForDrain } from "./drain";

describe("waitForDrain", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("waits for pending work", async () => {
    const pending = Promise.resolve("done");

    await waitForDrain([pending], 1000);
    await expect(pending).resolves.toBe("done");
  });

  it("stops waiting after the timeout", async () => {
    const pending = new Promise<void>(() => undefined);
    const drain = waitForDrain([pending], 10);
    await jest.advanceTimersByTimeAsync(10);
    await expect(drain).resolves.toBeUndefined();
  });

  it("does not reject when a pending task fails", async () => {
    const pending = Promise.reject(new Error("task failed"));

    await expect(waitForDrain([pending], 1000)).resolves.toBeUndefined();
  });
});
