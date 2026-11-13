import { DataSource } from "typeorm";
import { BetEvent } from "../src/bets/bet-event";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Event abuse protection", () => {
  let dataSource: DataSource;
  let service: BetProcessingService;

  const event: BetEvent = {
    betId: "abuse-bet-1",
    playerId: "abuse-player-1",
    currency: "USD",
    stake: 10,
    winAmount: 100,
    settledAt: "2026-11-12T10:00:00.000Z",
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    service = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1, EUR: 1.1 }),
    );
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("rejects the same bet id with a different win amount", async () => {
    await service.process("bet.settled", event, "event-1");

    await expect(
      service.process("bet.settled", { ...event, winAmount: 200 }, "event-2"),
    ).rejects.toThrow("Bet payload conflict");

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 100 }]);
  });

  it("rejects reuse of one event id for a different player", async () => {
    await service.process("bet.settled", event, "shared-event-id");

    await expect(
      service.process(
        "bet.settled",
        { ...event, playerId: "attacker" },
        "shared-event-id",
      ),
    ).rejects.toThrow("Event payload conflict");
  });

  it("does not double charge an identical bet with a new event id", async () => {
    await service.process("bet.settled", event, "event-1");
    await service.process("bet.settled", event, "event-2");

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 100 }]);
  });

  it("rejects a rollback with a conflicting player id", async () => {
    await service.process("bet.settled", event, "settle-event");

    await expect(
      service.process(
        "bet.rollback",
        { ...event, playerId: "attacker" },
        "rollback-event",
      ),
    ).rejects.toThrow("Bet payload conflict");

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 100 }]);
  });

  it("caps an event that would overflow the player balance", async () => {
    await dataSource.query(
      `INSERT INTO players (player_id, points, points_reached_at)
       VALUES ($1, 1999999999, now())`,
      [event.playerId],
    );

    await expect(
      service.process("bet.settled", { ...event, winAmount: 2 }),
    ).resolves.toEqual({ status: "processed" });

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    const bets = await dataSource.query(
      "SELECT points FROM bets WHERE bet_id = $1",
      [event.betId],
    );
    expect(players).toEqual([{ points: 2000000000 }]);
    expect(bets).toEqual([{ points: 1 }]);
  });

  it("rejects a conflicting rollback for a legacy bet without a fingerprint", async () => {
    await dataSource.query(
      `INSERT INTO players (player_id, points, points_reached_at)
       VALUES ($1, 100, now())`,
      [event.playerId],
    );
    await dataSource.query(
      `INSERT INTO bets (
        bet_id, player_id, currency, stake, win_amount, settled_at,
        points, status, payload_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, 100, 'settled', NULL)`,
      [
        event.betId,
        event.playerId,
        event.currency,
        event.stake,
        event.winAmount,
        event.settledAt,
      ],
    );

    await expect(
      service.process(
        "bet.rollback",
        { ...event, playerId: "attacker" },
        "legacy-rollback",
      ),
    ).rejects.toThrow("Bet payload conflict");
    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 100 }]);
  });

  it("rejects a conflicting legacy event id without a fingerprint", async () => {
    await dataSource.query(
      `INSERT INTO bet_events (
        event_id, bet_id, event_type, payload, payload_hash, status
      ) VALUES ('legacy-event', $1, 'bet.settled', $2, NULL, 'processed')`,
      [event.betId, JSON.stringify(event)],
    );

    await dataSource.query(
      `INSERT INTO bet_event_ids (event_id, received_at)
       SELECT event_id, received_at FROM bet_events WHERE event_id = 'legacy-event'`,
    );

    await expect(
      service.process(
        "bet.settled",
        { ...event, playerId: "attacker" },
        "legacy-event",
      ),
    ).rejects.toThrow("Event payload conflict");
  });

  it("rejects a conflicting rollback even after the tournament ends", async () => {
    await service.process("bet.settled", event, "settle-before-end");
    await dataSource.query(
      "UPDATE tournament_state SET ends_at = now() - interval '1 minute'",
    );

    await expect(
      service.process(
        "bet.rollback",
        { ...event, playerId: "attacker" },
        "conflict-after-end",
      ),
    ).rejects.toThrow("Bet payload conflict");
  });

  it("keeps a duplicate idempotent after currency configuration changes", async () => {
    await service.process("bet.settled", event, "event-before-config-change");
    const serviceWithoutCurrency = new BetProcessingService(
      dataSource,
      new PointsCalculator({}),
    );

    const result = await serviceWithoutCurrency.process(
      "bet.settled",
      event,
      "event-after-config-change",
    );

    expect(result).toEqual({ status: "ignored", reason: "duplicate_bet" });
  });

  it("accepts a converted win amount above the risk threshold", async () => {
    await service.process("bet.settled", {
      ...event,
      currency: "EUR",
      winAmount: 1000000,
    });

    const players = await dataSource.query(
      "SELECT points FROM players WHERE player_id = $1",
      [event.playerId],
    );
    expect(players).toEqual([{ points: 1100000 }]);
  });
});
