import { plainToInstance } from "class-transformer";
import {
  IsISO8601,
  IsString,
  Length,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validate,
} from "class-validator";
import { LIMITS } from "../config/limits";
import { Money, MoneyInput, preserveJsonNumbers } from "../money";

export class BetEventValidationError extends Error {}

@ValidatorConstraint({ name: "moneyAmount", async: false })
class MoneyAmountConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "bigint" &&
      !(value instanceof Money)
    ) {
      return false;
    }
    try {
      const amount = Money.from(value);
      return !amount.isNegative() && !amount.gt(LIMITS.MAX_BET_AMOUNT);
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return "must be a monetary amount within the configured limits";
  }
}

export class BetEvent {
  @IsString()
  @Length(1, LIMITS.MAX_ID_LENGTH)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  betId: string;

  @IsString()
  @Length(1, LIMITS.MAX_ID_LENGTH)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  playerId: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @Validate(MoneyAmountConstraint)
  stake: MoneyInput;

  @Validate(MoneyAmountConstraint)
  winAmount: MoneyInput;

  @IsISO8601()
  settledAt: string;
}

export function parseBetEventJson(raw: string): unknown {
  return JSON.parse(
    preserveJsonNumbers(raw, ["stake", "winAmount"]),
  ) as unknown;
}

export async function validateBetEvent(payload: unknown): Promise<BetEvent> {
  const event = plainToInstance(BetEvent, payload);
  const errors = await validate(event, {
    forbidNonWhitelisted: true,
    whitelist: true,
  });

  if (errors.length > 0) {
    const details = errors.map((error) => ({
      property: error.property,
      constraints: error.constraints,
    }));
    throw new BetEventValidationError(
      `Invalid bet event: ${JSON.stringify(details)}`,
    );
  }

  return event;
}
