import { eventFingerprint } from "./fingerprint";

describe("eventFingerprint", () => {
  it("changes when signed bytes change without changing business fields", () => {
    const compact = '{"betId":"bet-1","playerId":"player-1"}';
    const spaced = '{ "betId": "bet-1", "playerId": "player-1" }';

    expect(eventFingerprint("bet.settled", compact)).not.toBe(
      eventFingerprint("bet.settled", spaced),
    );
  });
});
