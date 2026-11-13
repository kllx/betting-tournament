import { Money } from "./money";
import { preserveJsonNumbers } from "./json";

describe("Money", () => {
  it("uses exact integer arithmetic for conversion and flooring", () => {
    const amount = Money.from("100.99");
    const rate = Money.from("1.1");

    expect(amount.multiply(rate).floorToBigInt()).toBe(111n);
    expect(
      Money.from("0.29999999999999999")
        .multiply(Money.from(10))
        .floorToBigInt(),
    ).toBe(2n);
  });

  it("preserves values beyond the safe JavaScript number range", () => {
    const amount = Money.from("9007199254740993.01");

    expect(amount.toString()).toBe("9007199254740993.01");
    expect(amount.floorToBigInt()).toBe(9007199254740993n);
  });

  it("normalizes decimal exponents without floating point", () => {
    expect(Money.from("1e-18").toString()).toBe("0.000000000000000001");
    expect(Money.from("1.25e3").toString()).toBe("1250");
    expect(Money.from(1e-7).toString()).toBe("0.0000001");
  });

  it("rejects precision beyond the fixed scale", () => {
    expect(() => Money.from("0.0000000000000000001")).toThrow(
      "Money precision exceeds 18 digits",
    );
  });

  it("compares amounts without converting them to numbers", () => {
    expect(
      Money.from("9007199254740993.01").gt(Money.from("9007199254740993")),
    ).toBe(true);
    expect(Money.from("1.10").equals(Money.from("1.1"))).toBe(true);
  });

  it("rejects invalid numeric values", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "NaN", "1,2"]) {
      expect(() => Money.from(value)).toThrow("Invalid money value");
    }
  });
});

describe("preserveJsonNumbers", () => {
  it("preserves all numeric literals when fields are not restricted", () => {
    const payload = JSON.parse(
      preserveJsonNumbers('{"rates":[0.1,0.2],"nested":{"amount":1e-7}}'),
    );

    expect(payload).toEqual({
      rates: ["0.1", "0.2"],
      nested: { amount: "1e-7" },
    });
  });
  it("preserves exact monetary number literals before JSON parsing", () => {
    const raw =
      '{"betId":"bet-1","winAmount":0.29999999999999999,"stake":1e-7,"note":"winAmount:999"}';
    const payload = JSON.parse(
      preserveJsonNumbers(raw, ["stake", "winAmount"]),
    );

    expect(payload.winAmount).toBe("0.29999999999999999");
    expect(payload.stake).toBe("1e-7");
    expect(payload.note).toBe("winAmount:999");
  });
});
