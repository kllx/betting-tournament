import { DataSource } from "typeorm";
import { OutboxRelay } from "../src/outbox/outbox.relay";
import { TournamentService } from "../src/tournament/tournament.service";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("OutboxRelay", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await dataSource.query(
      `INSERT INTO players (player_id, points, points_reached_at)
       VALUES ('winner', 10, now())`,
    );
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );
    await new TournamentService(dataSource, [100]).finalizeDue();
    await dataSource.query(
      "DELETE FROM outbox WHERE event_type = 'tournament.phase.changed'",
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("publishes each outbox record once after a database commit", async () => {
    const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    const relay = new OutboxRelay(dataSource, publisher, 10, undefined, 10, 5);

    await relay.flush();
    await relay.flush();

    const records = await dataSource.query(
      "SELECT status, published_at FROM outbox",
    );
    expect(records).toEqual([
      { status: "PUBLISHED", published_at: expect.any(Date) },
    ]);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(
      "payout.requested",
      expect.objectContaining({ playerId: "winner" }),
      "payout:winner",
    );
  });

  it("keeps an unpublished record retryable after a broker failure", async () => {
    const publisher = {
      publish: jest
        .fn()
        .mockRejectedValueOnce(new Error("broker unavailable"))
        .mockResolvedValue(undefined),
    };
    const relay = new OutboxRelay(dataSource, publisher, 10, undefined, 10, 5);

    await relay.flush();
    let records = await dataSource.query("SELECT status, attempts FROM outbox");
    expect(records).toEqual([{ status: "NEW", attempts: 1 }]);

    await dataSource.query(
      "UPDATE outbox SET available_at = now() - interval '1 second'",
    );
    await relay.flush();
    records = await dataSource.query("SELECT status, attempts FROM outbox");
    expect(records).toEqual([{ status: "PUBLISHED", attempts: 1 }]);
  });

  it("marks an event failed after five publish attempts", async () => {
    const publisher = {
      publish: jest.fn().mockRejectedValue(new Error("broker unavailable")),
    };
    const relay = new OutboxRelay(dataSource, publisher, 10, undefined, 10, 5);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await dataSource.query("UPDATE outbox SET available_at = now()");
      await relay.flush();
    }

    const records = await dataSource.query(
      "SELECT status, attempts FROM outbox",
    );
    expect(records).toEqual([{ status: "FAILED", attempts: 5 }]);
    await relay.flush();
    expect(publisher.publish).toHaveBeenCalledTimes(5);
  });

  it("publishes disjoint batches during concurrent flushes", async () => {
    await dataSource.query(`
      INSERT INTO outbox (event_id, event_type, payload)
      SELECT 'event-' || g, 'player.score.changed', '{}'
      FROM generate_series(1, 20) AS g
    `);
    const firstPublisher = {
      publish: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    };
    const secondPublisher = {
      publish: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    };

    await Promise.all([
      new OutboxRelay(dataSource, firstPublisher, 10, undefined, 10, 5).flush(),
      new OutboxRelay(
        dataSource,
        secondPublisher,
        10,
        undefined,
        10,
        5,
      ).flush(),
    ]);

    const records = await dataSource.query(
      "SELECT status, count(*)::int AS count FROM outbox GROUP BY status",
    );
    expect(records).toEqual(
      expect.arrayContaining([
        { status: "PUBLISHED", count: 20 },
        { status: "NEW", count: 1 },
      ]),
    );
    expect(firstPublisher.publish).toHaveBeenCalledTimes(10);
    expect(secondPublisher.publish).toHaveBeenCalledTimes(10);
  });

  it("retries only failed records after a partial broker outage", async () => {
    await dataSource.query(`
      INSERT INTO outbox (event_id, event_type, payload) VALUES
      ('score:one', 'player.score.changed', '{}'),
      ('score:two', 'player.score.changed', '{}')
    `);
    const publisher = {
      publish: jest.fn().mockImplementation((_type, _payload, eventId) => {
        if (eventId === "payout:winner") {
          return Promise.reject(new Error("broker unavailable"));
        }
        return Promise.resolve();
      }),
    };
    const relay = new OutboxRelay(dataSource, publisher, 10, undefined, 10, 5);

    await relay.flush();

    let records = await dataSource.query(
      "SELECT event_id, status FROM outbox ORDER BY event_id",
    );
    expect(records).toEqual([
      { event_id: "payout:winner", status: "NEW" },
      { event_id: "score:one", status: "PUBLISHED" },
      { event_id: "score:two", status: "PUBLISHED" },
    ]);

    publisher.publish.mockResolvedValue(undefined);
    await dataSource.query("UPDATE outbox SET available_at = now()");
    await relay.flush();
    records = await dataSource.query(
      "SELECT event_id, status FROM outbox ORDER BY event_id",
    );
    expect(records.every((record: any) => record.status === "PUBLISHED")).toBe(
      true,
    );
    expect(
      publisher.publish.mock.calls.filter((call) => call[2] === "score:one"),
    ).toHaveLength(1);
    expect(
      publisher.publish.mock.calls.filter(
        (call) => call[2] === "payout:winner",
      ),
    ).toHaveLength(2);
  });
});
