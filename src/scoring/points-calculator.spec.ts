import { PointsCalculator } from "./points-calculator";

describe("PointsCalculator", () => {
  it("converts the win amount to USD and discards the fractional point", () => {
    const calculator = new PointsCalculator({ USD: 1, EUR: 1.1 });

    expect(calculator.calculate(100.99, "EUR")).toBe(111);
  });

  it("uses decimal arithmetic at an exact point boundary", () => {
    const calculator = new PointsCalculator({ EUR: 10 });

    expect(calculator.calculate(0.3, "EUR")).toBe(3);
  });

  it("preserves the exact decimal literal from the event payload", () => {
    const calculator = new PointsCalculator({ EUR: 10 });

    expect(calculator.calculate("0.29999999999999999", "EUR")).toBe(2);
  });

  it("accepts BigInt and decimal strings throughout conversion", () => {
    const calculator = new PointsCalculator({ EUR: "1.1" }, "100000");

    expect(calculator.calculate(100n, "EUR")).toBe(110);
  });

  it("accepts a large win and emits a risk signal", () => {
    const metrics = { largeWin: jest.fn() };
    const calculator = new PointsCalculator({ USD: 1 }, 100000, metrics);

    expect(calculator.calculate(100001, "USD")).toBe(100001);
    expect(metrics.largeWin).toHaveBeenCalledTimes(1);
  });

  it("rejects a currency without a configured USD rate", () => {
    const calculator = new PointsCalculator({ USD: 1 });

    expect(() => calculator.calculate(10, "GBP")).toThrow(
      "Currency is not configured: GBP",
    );
  });
});
