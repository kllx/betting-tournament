import { performance } from "node:perf_hooks";
import { BetEvent } from "../src/bets/bet-event";
import { betFingerprint, eventFingerprint } from "../src/security/fingerprint";

const iterations = 100000;
const event: BetEvent = {
  betId: "benchmark-bet",
  playerId: "benchmark-player",
  currency: "USD",
  stake: 10,
  winAmount: 100,
  settledAt: "2026-11-12T10:00:00.000Z",
};
const raw = JSON.stringify(event);
const started = performance.now();
for (let index = 0; index < iterations; index += 1) {
  betFingerprint(event);
  eventFingerprint("bet.settled", raw);
}
const durationMs = performance.now() - started;
process.stdout.write(
  `${JSON.stringify({
    iterations,
    durationMs: Number(durationMs.toFixed(2)),
    microsecondsPerBet: Number(((durationMs * 1000) / iterations).toFixed(2)),
    betsPerSecond: Math.round(iterations / (durationMs / 1000)),
  })}\n`,
);
