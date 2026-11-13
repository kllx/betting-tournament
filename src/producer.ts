import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { connect } from "amqplib";
import { validateBetEvent } from "./bets/bet-event";
import configuration from "./config/configuration";
import { publishMandatory } from "./messaging/publish-mandatory";
import { EventSigner } from "./security/event-signer";

async function main(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const [routingKey, rawEvent] = process.argv.slice(2);
  if (
    (routingKey !== "bet.settled" && routingKey !== "bet.rollback") ||
    !rawEvent
  ) {
    throw new Error(
      'Usage: npm run producer -- bet.settled \'{"betId":"bet-1",...}\'',
    );
  }

  const event = await validateBetEvent(JSON.parse(rawEvent));
  const config = configuration();
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) > config.security.maxEventBytes) {
    throw new Error("Event payload is too large");
  }
  const eventId = randomUUID();
  const signer = new EventSigner(
    config.security.eventSigningSecret,
    "bet-event-v1",
  );
  const connection = await connect(config.rabbitmq.url);
  try {
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(config.rabbitmq.exchange, "topic", {
      durable: true,
    });
    await publishMandatory(
      channel,
      config.rabbitmq.exchange,
      routingKey,
      Buffer.from(body),
      {
        contentType: "application/json",
        messageId: eventId,
        persistent: true,
        headers: signer.sign(routingKey, body, eventId),
      },
      config.rabbitmq.publishConfirmTimeoutMs,
    );
    await channel.close();
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof SyntaxError ? "Invalid JSON" : error);
  process.exitCode = 1;
});
