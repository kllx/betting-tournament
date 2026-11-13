export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    private readonly now: () => number,
  ) {
    if (ratePerSecond <= 0 || capacity <= 0) {
      throw new Error("Token bucket rate and capacity must be positive");
    }
    this.tokens = capacity;
    this.lastRefill = now();
  }

  consume(amount: number): number {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsedMs * this.ratePerSecond) / 1000,
    );
    this.lastRefill = now;
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return 0;
    }
    const missing = amount - this.tokens;
    this.tokens = 0;
    const delay = Math.ceil((missing * 1000) / this.ratePerSecond);
    this.lastRefill = now + delay;
    return delay;
  }
}
