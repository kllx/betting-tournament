import { TokenBucket } from "./token-bucket";

describe("TokenBucket", () => {
  it("paces batches at the configured rate", () => {
    let now = 0;
    const bucket = new TokenBucket(100, 10, () => now);

    expect(bucket.consume(10)).toBe(0);
    expect(bucket.consume(10)).toBe(100);
    now = 100;
    expect(bucket.consume(10)).toBe(100);
    now = 200;
    expect(bucket.consume(10)).toBe(100);
  });

  it("does not accumulate unused capacity beyond the bucket size", () => {
    let now = 1000;
    const bucket = new TokenBucket(100, 10, () => now);

    expect(bucket.consume(10)).toBe(0);
    now = 1010;
    expect(bucket.consume(10)).toBe(90);
  });

  it("accounts for reserved time between sequential batches", () => {
    let now = 0;
    const bucket = new TokenBucket(1000, 50, () => now);

    for (let batch = 0; batch < 40; batch += 1) {
      now += bucket.consume(50);
      now += 7;
    }

    expect(now).toBeGreaterThanOrEqual(1900);
    expect(now).toBeLessThanOrEqual(2200);
  });
});
