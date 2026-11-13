import { ConfirmChannel } from "amqplib";
import { publishMandatory } from "./publish-mandatory";

describe("publishMandatory timeout", () => {
  it("closes the channel when the broker does not confirm in time", async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const channel = {
      on: jest.fn(),
      publish: jest.fn(),
      close,
    } as unknown as ConfirmChannel;

    await expect(
      publishMandatory(
        channel,
        "betting",
        "player.score.changed",
        Buffer.from("{}"),
        { messageId: "event-1" },
        20,
      ),
    ).rejects.toThrow("RabbitMQ publish confirm timeout");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
