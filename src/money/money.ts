const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const MAX_EXPONENT = 1000;

export type MoneyInput = Money | string | number | bigint;

export class InvalidMoneyError extends SyntaxError {}

export class Money {
  private constructor(private readonly units: bigint) {}

  static from(value: MoneyInput): Money {
    if (value instanceof Money) {
      return value;
    }
    if (typeof value === "bigint") {
      return new Money(value * SCALE_FACTOR);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new InvalidMoneyError("Invalid money value");
    }
    const text = String(value);
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) {
      throw new InvalidMoneyError("Invalid money value");
    }
    const [, sign, integer, fraction = "", exponentText = "0"] = match;
    const exponent = Number(exponentText);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
      throw new InvalidMoneyError("Invalid money value");
    }
    const digits = `${integer}${fraction}`;
    const unitExponent = SCALE + exponent - fraction.length;
    let units: bigint;
    if (unitExponent >= 0) {
      units = BigInt(digits) * 10n ** BigInt(unitExponent);
    } else {
      const divisor = 10n ** BigInt(-unitExponent);
      const numerator = BigInt(digits);
      if (numerator % divisor !== 0n) {
        throw new InvalidMoneyError(`Money precision exceeds ${SCALE} digits`);
      }
      units = numerator / divisor;
    }
    return new Money(sign === "-" ? -units : units);
  }

  multiply(other: MoneyInput): Money {
    const rate = Money.from(other);
    return new Money((this.units * rate.units) / SCALE_FACTOR);
  }

  floorToBigInt(): bigint {
    return this.units / SCALE_FACTOR;
  }

  gt(other: MoneyInput): boolean {
    return this.units > Money.from(other).units;
  }

  equals(other: MoneyInput): boolean {
    return this.units === Money.from(other).units;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  toString(): string {
    const negative = this.units < 0n;
    const absolute = negative ? -this.units : this.units;
    const whole = absolute / SCALE_FACTOR;
    const fraction = (absolute % SCALE_FACTOR)
      .toString()
      .padStart(SCALE, "0")
      .replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
  }

  toJSON(): string {
    return this.toString();
  }
}
