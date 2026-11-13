import { BetEvent } from "../bets/bet-event";
import { betFingerprint } from "../security/fingerprint";

export function fingerprintLegacyBet(payload: unknown): string | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const event = payload as Partial<BetEvent>;
  if (
    typeof event.betId !== "string" ||
    typeof event.playerId !== "string" ||
    typeof event.currency !== "string" ||
    typeof event.stake !== "number" ||
    typeof event.winAmount !== "number" ||
    typeof event.settledAt !== "string"
  ) {
    return null;
  }
  return betFingerprint(event as BetEvent);
}
