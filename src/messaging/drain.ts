export async function waitForDrain(
  pending: Iterable<Promise<unknown>>,
  timeoutMs: number,
): Promise<void> {
  const tasks = [...pending];
  if (tasks.length === 0) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
