import { randomUUID } from "node:crypto";
import { EventSigner } from "../src/security/event-signer";

export const testEventSigningSecret = "test-external-event-signing-secret-32";

export function signInternalEvent(
  routingKey: string,
  payload: unknown,
): { messageId: string; headers: Record<string, string> } {
  const eventId = randomUUID();
  const signer = new EventSigner(
    "local-internal-event-signing-secret-32",
    "internal-event-v1",
  );
  return {
    messageId: eventId,
    headers: signer.sign(routingKey, JSON.stringify(payload), eventId),
  };
}

export function signBetEvent(
  routingKey: string,
  payload: unknown,
): {
  messageId: string;
  headers: Record<string, string>;
} {
  const eventId = randomUUID();
  const signer = new EventSigner(testEventSigningSecret, "bet-event-v1");
  return {
    messageId: eventId,
    headers: signer.sign(routingKey, JSON.stringify(payload), eventId),
  };
}
