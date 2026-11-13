import { LIMITS } from "../config/limits";
import { Money, MoneyInput } from "../money";
import { MetricsService } from "../observability/metrics.service";

export class UnsupportedCurrencyError extends Error {}

export class PointsCalculator {
  private readonly largeWinThresholdUsd: Money;

  constructor(
    private readonly rates: Record<string, MoneyInput>,
    largeWinThresholdUsd: MoneyInput = LIMITS.DEFAULT_MAX_WIN_AMOUNT_USD,
    private readonly metrics?: Pick<MetricsService, "largeWin">,
  ) {
    this.largeWinThresholdUsd = Money.from(largeWinThresholdUsd);
  }

  calculate(winAmount: MoneyInput, currency: string): number {
    const rate = this.rates[currency];
    if (rate === undefined) {
      throw new UnsupportedCurrencyError(
        `Currency is not configured: ${currency}`,
      );
    }

    const usdAmount = Money.from(winAmount).multiply(rate);
    if (usdAmount.gt(this.largeWinThresholdUsd)) {
      this.metrics?.largeWin();
    }
    return Number(usdAmount.floorToBigInt());
  }
}
