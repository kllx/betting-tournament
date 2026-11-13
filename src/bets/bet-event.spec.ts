import { parseBetEventJson, validateBetEvent } from "./bet-event";

const validEvent = {
  betId: "bet-1",
  playerId: "player-1",
  currency: "EUR",
  stake: 10,
  winAmount: 25.5,
  settledAt: "2026-11-12T10:00:00.000Z",
};

describe("validateBetEvent", () => {
  it("accepts a valid bet event", async () => {
    await expect(validateBetEvent(validEvent)).resolves.toEqual(validEvent);
  });

  it("rejects a negative win amount", async () => {
    await expect(
      validateBetEvent({ ...validEvent, winAmount: -1 }),
    ).rejects.toThrow("Invalid bet event");
  });

  it("rejects an empty player id", async () => {
    await expect(
      validateBetEvent({ ...validEvent, playerId: "" }),
    ).rejects.toThrow("Invalid bet event");
  });

  it("rejects control characters in player and bet ids", async () => {
    await expect(
      validateBetEvent({ ...validEvent, playerId: "player\nforged-log" }),
    ).rejects.toThrow("Invalid bet event");
  });

  it("rejects an unbounded stake", async () => {
    await expect(
      validateBetEvent({ ...validEvent, stake: Number.MAX_VALUE }),
    ).rejects.toThrow("Invalid bet event");
  });

  it("does not expose event values in validation errors", async () => {
    await expect(
      validateBetEvent({ ...validEvent, winAmount: -1 }),
    ).rejects.not.toThrow("player-1");
  });

  it("accepts exact decimal strings as monetary values", async () => {
    await expect(
      validateBetEvent({ ...validEvent, winAmount: "0.29999999999999999" }),
    ).resolves.toMatchObject({ winAmount: "0.29999999999999999" });
  });

  it("preserves monetary literals while parsing RabbitMQ JSON", () => {
    const raw = JSON.stringify(validEvent).replace(
      '"winAmount":25.5',
      '"winAmount":0.29999999999999999',
    );

    const payload = parseBetEventJson(raw) as { winAmount: string };
    expect(payload.winAmount).toBe("0.29999999999999999");
  });
});
