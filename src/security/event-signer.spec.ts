import { EventSigner, MessageAuthenticationError } from "./event-signer";

describe("EventSigner", () => {
  const signer = new EventSigner("external-test-secret", "bet-event-v1");
  const eventId = "5a7df7bc-92b6-4b0f-b46d-c17d9cb2ad0f";
  const payload = '{"betId":"bet-1","winAmount":100}';

  it("accepts a signature over the exact event identity and payload", () => {
    const headers = signer.sign("bet.settled", payload, eventId);

    expect(() => signer.verify("bet.settled", payload, headers)).not.toThrow();
  });

  it("rejects a modified payload with the original signature", () => {
    const headers = signer.sign("bet.settled", payload, eventId);

    expect(() =>
      signer.verify("bet.settled", payload.replace("100", "1000000"), headers),
    ).toThrow(MessageAuthenticationError);
  });

  it("accepts an internal idempotency key containing a colon", () => {
    const internal = new EventSigner(
      "internal-test-secret",
      "internal-event-v1",
    );
    const headers = internal.sign("payout.requested", payload, "payout:carol");

    expect(() =>
      internal.verify("payout.requested", payload, headers),
    ).not.toThrow();
  });

  it("rejects a signature from another event domain", () => {
    const internal = new EventSigner(
      "external-test-secret",
      "internal-event-v1",
    );
    const headers = internal.sign("payout.requested", payload, eventId);

    expect(() => signer.verify("bet.settled", payload, headers)).toThrow(
      MessageAuthenticationError,
    );
  });
});
