export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const inFlight = new Set<Promise<void>>();
  const results: R[] = [];
  let firstError: unknown;
  let hasError = false;
  for (const item of items) {
    const tracked = Promise.resolve()
      .then(() => handler(item))
      .catch((error: unknown) => {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      })
      .then((result: R) => {
        results.push(result);
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  }
  await Promise.allSettled(inFlight);
  if (hasError) {
    throw firstError;
  }
  return results;
}
