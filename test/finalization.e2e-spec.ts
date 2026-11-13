import { DataSource } from "typeorm";
import { BetEvent } from "../src/bets/bet-event";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { TournamentService } from "../src/tournament/tournament.service";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Tournament finalization", () => {
  let dataSource: DataSource;
  let tournament: TournamentService;
  let betProcessing: BetProcessingService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    tournament = new TournamentService(dataSource, [100, 50, 25]);
    betProcessing = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1 }),
    );
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("atomically freezes winners and creates payouts once", async () => {
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at) VALUES
      ('alice', 100, '2026-11-12T10:02:00Z'),
      ('bob', 100, '2026-11-12T10:01:00Z'),
      ('carol', 150, '2026-11-12T10:03:00Z'),
      ('dave', 50, '2026-11-12T10:00:00Z')
    `);
    await dataSource.query(`
      UPDATE tournament_state SET
        ends_at = now() - interval '16 minutes',
        settlement_cutoff_at = now() - interval '6 minutes',
        finalize_at = now() - interval '1 minute'
    `);

    const first = await tournament.finalizeDue();
    const second = await tournament.finalizeDue();

    expect(first).toEqual({ finalized: true, phase: "PAYING" });
    expect(second).toEqual({ finalized: true, phase: "PAYING" });
    const winners = await dataSource.query(
      "SELECT rank, player_id, points FROM tournament_winners ORDER BY rank",
    );
    expect(winners).toEqual([
      { rank: 1, player_id: "carol", points: 150 },
      { rank: 2, player_id: "bob", points: 100 },
      { rank: 3, player_id: "alice", points: 100 },
    ]);
    const payouts = await dataSource.query(
      "SELECT player_id, amount, currency, status FROM payouts ORDER BY rank",
    );
    expect(payouts).toEqual([
      { player_id: "carol", amount: "100", currency: "USD", status: "PENDING" },
      { player_id: "bob", amount: "50", currency: "USD", status: "PENDING" },
      { player_id: "alice", amount: "25", currency: "USD", status: "PENDING" },
    ]);
    const outbox = await dataSource.query(
      "SELECT event_id, event_type FROM outbox WHERE event_type = 'payout.requested' ORDER BY event_id",
    );
    expect(outbox).toHaveLength(3);
    expect(
      outbox.every((row: any) => row.event_type === "payout.requested"),
    ).toBe(true);
  });

  it("does not finalize before the fifteen minute deadline", async () => {
    const result = await tournament.finalizeDue();

    expect(result).toEqual({ finalized: false, phase: "ACTIVE" });
    const winners = await dataSource.query("SELECT * FROM tournament_winners");
    expect(winners).toEqual([]);
  });

  it("does not lose a score change racing with finalization", async () => {
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at)
      VALUES ('existing-player', 1, now())
    `);
    await dataSource.query(`
      UPDATE tournament_state SET
        ends_at = now() - interval '16 minutes',
        settlement_cutoff_at = now() + interval '10 minutes',
        finalize_at = now()
    `);
    const events = Array.from({ length: 20 }, (_, index): BetEvent => ({
      betId: `race-bet-${index}`,
      playerId: "race-player",
      currency: "USD",
      stake: 1,
      winAmount: 1,
      settledAt: "2026-11-12T10:00:00.000Z",
    }));

    await Promise.all([
      tournament.finalizeDue(),
      ...events.map((event) => betProcessing.process("bet.settled", event)),
    ]);

    const [player] = await dataSource.query(
      "SELECT points FROM players WHERE player_id = 'race-player'",
    );
    const [snapshot] = await dataSource.query(
      "SELECT points FROM tournament_winners WHERE player_id = 'race-player'",
    );
    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    expect(state[0].phase).toBe("PAYING");
    expect(snapshot?.points ?? 0).toBe(player?.points ?? 0);
  });

  it("creates one winner and payout set during concurrent finalization", async () => {
    await dataSource.query(`
      INSERT INTO players (player_id, points, points_reached_at)
      SELECT 'player-' || g, g, now() FROM generate_series(1, 1000) AS g
    `);
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );

    const results = await Promise.all([
      tournament.finalizeDue(),
      tournament.finalizeDue(),
    ]);

    expect(results).toEqual([
      { finalized: true, phase: "PAYING" },
      { finalized: true, phase: "PAYING" },
    ]);
    const counts = await dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM tournament_winners) AS winners,
        (SELECT count(*)::int FROM payouts) AS payouts,
        (SELECT count(*)::int FROM outbox WHERE event_type = 'payout.requested') AS events
    `);
    expect(counts).toEqual([{ winners: 3, payouts: 3, events: 3 }]);
  });

  it("finishes as paid without winners", async () => {
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );

    await expect(tournament.finalizeDue()).resolves.toEqual({
      finalized: true,
      phase: "PAID",
    });
    const payouts = await dataSource.query("SELECT * FROM payouts");
    expect(payouts).toEqual([]);
  });

  it("serializes payout amounts as exact decimal strings", async () => {
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('winner', 100)",
    );
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );

    await tournament.finalizeDue();

    const events = await dataSource.query(
      "SELECT payload FROM outbox WHERE event_id = 'payout:winner'",
    );
    expect(events[0].payload.amount).toBe("100");
  });

  it("writes a versioned phase change to the same outbox transaction", async () => {
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('winner', 100)",
    );
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );

    await tournament.finalizeDue();

    const events = await dataSource.query(
      "SELECT payload FROM outbox WHERE event_type = 'tournament.phase.changed'",
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.phase).toBe("PAYING");
    expect(Number(events[0].payload.version)).toBeGreaterThan(0);
  });

  it("rolls back the complete snapshot when payout outbox creation fails", async () => {
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('winner', 100)",
    );
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );
    await dataSource.query(`
      INSERT INTO outbox (event_id, event_type, payload)
      VALUES ('payout:winner', 'payout.requested', '{}')
    `);

    await expect(tournament.finalizeDue()).rejects.toThrow();

    const counts = await dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM leaderboard_snapshots) AS snapshots,
        (SELECT count(*)::int FROM tournament_winners) AS winners,
        (SELECT count(*)::int FROM payouts) AS payouts,
        (SELECT phase FROM tournament_state WHERE id = 1) AS phase
    `);
    expect(counts).toEqual([
      { snapshots: 0, winners: 0, payouts: 0, phase: "ACTIVE" },
    ]);

    await dataSource.query(
      "DELETE FROM outbox WHERE event_id = 'payout:winner'",
    );
    await expect(tournament.finalizeDue()).resolves.toEqual({
      finalized: true,
      phase: "PAYING",
    });
  });
});
