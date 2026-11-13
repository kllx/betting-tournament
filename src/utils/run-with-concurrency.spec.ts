import { runWithConcurrency } from "./run-with-concurrency";

describe("runWithConcurrency", () => {
  it("keeps at most the configured number of tasks in flight", async () => {
    const running = new Set<number>();
    let maxRunning = 0;

    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      running.add(item);
      maxRunning = Math.max(maxRunning, running.size);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running.delete(item);
    });

    expect(maxRunning).toBe(2);
    expect(running.size).toBe(0);
  });

  it("waits for remaining tasks after a failure", async () => {
    const completed: number[] = [];
    const operation = runWithConcurrency([1, 2], 2, async (item) => {
      if (item === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("task failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      completed.push(item);
    });

    await expect(operation).rejects.toThrow("task failed");
    expect(completed).toEqual([2]);
  });

  it("rejects when a task fails", async () => {
    await expect(
      runWithConcurrency([1, 2], 1, (item) => {
        if (item === 2) {
          return Promise.reject(new Error("task failed"));
        }
        return Promise.resolve();
      }),
    ).rejects.toThrow("task failed");
  });
});
