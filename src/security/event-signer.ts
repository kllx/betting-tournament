import { createHmac, timingSafeEqual } from "node:crypto";
import { LIMITS } from "../config/limits";
import { HTTP_HEADERS } from "../contracts/http";

const EVENT_ID_PATTERN = new RegExp(
  `^[a-zA-Z0-9:_-]{8,${LIMITS.MAX_EVENT_ID_LENGTH}}$`,
);

export interface SignedEventHeaders extends Record<string, string> {
  "x-event-id": string;
  "x-signature": string;
}

export class MessageAuthenticationError extends Error {}

export class EventSigner {
  constructor(
    private readonly secret: string,
    private readonly domain: string,
  ) {}

  sign(
    routingKey: string,
    payload: string,
    eventId: string,
  ): SignedEventHeaders {
    return {
      [HTTP_HEADERS.EVENT_ID]: eventId,
      [HTTP_HEADERS.SIGNATURE]: this.signature(routingKey, payload, eventId),
    };
  }

  verify(
    routingKey: string,
    payload: string,
    headers: Record<string, unknown> | undefined,
  ): void {
    const eventId = headers?.[HTTP_HEADERS.EVENT_ID];
    const signature = headers?.[HTTP_HEADERS.SIGNATURE];
    if (
      typeof eventId !== "string" ||
      !EVENT_ID_PATTERN.test(eventId) ||
      typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      throw new MessageAuthenticationError(
        "Missing or invalid event authentication headers",
      );
    }
    const expected = this.signature(routingKey, payload, eventId);
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      )
    ) {
      throw new MessageAuthenticationError("Invalid event signature");
    }
  }

  eventId(headers: Record<string, unknown> | undefined): string {
    const eventId = headers?.[HTTP_HEADERS.EVENT_ID];
    if (typeof eventId !== "string") {
      throw new MessageAuthenticationError("Missing event id");
    }
    return eventId;
  }

  private signature(
    routingKey: string,
    payload: string,
    eventId: string,
  ): string {
    return createHmac("sha256", this.secret)
      .update(this.domain)
      .update("\n")
      .update(routingKey)
      .update("\n")
      .update(eventId)
      .update("\n")
      .update(payload)
      .digest("hex");
  }
}
