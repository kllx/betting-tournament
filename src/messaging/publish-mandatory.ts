import { ConfirmChannel, ConsumeMessage, Options } from "amqplib";

interface ReturnState {
  messages: ConsumeMessage[];
}

const returnStates = new WeakMap<ConfirmChannel, ReturnState>();

export class UnroutableMessageError extends Error {
  constructor() {
    super("Unroutable message");
  }
}

function returnState(channel: ConfirmChannel): ReturnState {
  let state = returnStates.get(channel);
  if (!state) {
    state = { messages: [] };
    channel.on("return", (message) => {
      state!.messages.push(message);
    });
    returnStates.set(channel, state);
  }
  return state;
}

export async function publishMandatory(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: Options.Publish,
  timeoutMs: number,
): Promise<void> {
  const state = returnState(channel);
  const operation = new Promise<void>((resolve, reject) => {
    channel.publish(
      exchange,
      routingKey,
      content,
      { ...options, mandatory: true },
      (error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const returnedIndex = state.messages.findIndex(
          (message) => message.properties.messageId === options.messageId,
        );
        if (returnedIndex >= 0) {
          state.messages.splice(returnedIndex, 1);
          reject(new UnroutableMessageError());
        } else {
          resolve();
        }
      },
    );
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          void channel.close().catch(() => undefined);
          reject(new Error("RabbitMQ publish confirm timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
