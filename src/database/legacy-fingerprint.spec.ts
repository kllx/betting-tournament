import { betFingerprint } from "../security/fingerprint";
import { fingerprintLegacyBet } from "./legacy-fingerprint";

describe("fingerprintLegacyBet", () => {
  it("uses the original settledAt from the source event", () => {
    const rawEvent = {
      betId: "bet-1",
      playerId: "player-1",
      currency: "USD",
      stake: 1,
      winAmount: 1,
      settledAt: "2026-11-12T13:00:00+03:00",
    };

    expect(fingerprintLegacyBet(rawEvent)).toBe(betFingerprint(rawEvent));
  });

  it("returns null when the original event is unavailable", () => {
    expect(fingerprintLegacyBet(null)).toBeNull();
  });
});
