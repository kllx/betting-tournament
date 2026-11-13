import { createHash } from "node:crypto";
import { BetEvent } from "../bets/bet-event";

export class EventPayloadConflictError extends Error {}
export class BetPayloadConflictError extends Error {}

export function betFingerprint(event: BetEvent): string {
  const payload = [
    event.betId,
    event.playerId,
    event.currency,
    event.stake,
    event.winAmount,
    event.settledAt,
  ].map((value) =>
    JSON.stringify(typeof value === "bigint" ? value.toString() : value),
  );
  return createHash("sha256").update(payload.join("\n")).digest("hex");
}

export function eventFingerprint(type: string, rawPayload: string): string {
  return createHash("sha256")
    .update(type)
    .update("\n")
    .update(rawPayload)
    .digest("hex");
}
