import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LIMITS } from "../config/limits";
import { SignedInternalConsumer } from "../messaging/signed-internal.consumer";
import { PayoutService } from "./payout.service";

@Injectable()
export class PayoutConsumer
  extends SignedInternalConsumer
  implements OnModuleInit, OnModuleDestroy
{
  protected readonly queueSuffix = "payouts";

  constructor(
    config: ConfigService,
    private readonly payouts: PayoutService,
  ) {
    super(config);
  }

  async onModuleInit(): Promise<void> {
    await this.start("payout.requested", 20);
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  protected async process(payload: unknown): Promise<void> {
    const payoutId = (payload as { payoutId?: unknown }).payoutId;
    if (
      typeof payoutId !== "string" ||
      payoutId.length === 0 ||
      payoutId.length > LIMITS.MAX_PAYOUT_ID_LENGTH
    ) {
      throw new SyntaxError("Invalid payout event");
    }
    await this.payouts.markPaid(payoutId);
  }
}
