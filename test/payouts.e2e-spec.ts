import { DataSource } from "typeorm";
import { PayoutService } from "../src/payouts/payout.service";
import { TournamentService } from "../src/tournament/tournament.service";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Payout processing", () => {
  let dataSource: DataSource;
  let payouts: PayoutService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    payouts = new PayoutService(dataSource);
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await dataSource.query(
      `INSERT INTO players (player_id, points, points_reached_at)
       VALUES ('winner', 10, now())`,
    );
    await dataSource.query(`
      UPDATE tournament_state SET
        ends_at = now() - interval '16 minutes',
        settlement_cutoff_at = now() - interval '6 minutes',
        finalize_at = now() - interval '1 minute'
    `);
    await new TournamentService(dataSource, [100]).finalizeDue();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("applies a payout delivery once and completes the tournament", async () => {
    await payouts.markPaid("tournament:default:payout:winner");
    await payouts.markPaid("tournament:default:payout:winner");

    const payout = await dataSource.query(
      "SELECT status, attempts FROM payouts WHERE player_id = 'winner'",
    );
    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    expect(payout).toEqual([{ status: "PAID", attempts: 1 }]);
    expect(state).toEqual([{ phase: "PAID" }]);
    const phases = await dataSource.query(
      "SELECT payload FROM outbox WHERE event_type = 'tournament.phase.changed' ORDER BY id",
    );
    expect(
      phases.map((row: { payload: { phase: string } }) => row.payload.phase),
    ).toEqual(["PAYING", "PAID"]);
  });

  it("completes the tournament when a duplicate payout follows a lost phase update", async () => {
    await dataSource.query(
      "UPDATE payouts SET status = 'PAID', paid_at = now(), attempts = 1",
    );

    await payouts.markPaid("tournament:default:payout:winner");

    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    const payout = await dataSource.query(
      "SELECT attempts FROM payouts WHERE player_id = 'winner'",
    );
    expect(state).toEqual([{ phase: "PAID" }]);
    expect(payout).toEqual([{ attempts: 1 }]);
  });

  it("keeps the tournament paying while another payout is pending", async () => {
    await dataSource.query(
      `INSERT INTO players (player_id, points, points_reached_at)
       VALUES ('second', 5, now())`,
    );
    await dataSource.query("DELETE FROM payouts");
    await dataSource.query("DELETE FROM tournament_winners");
    await dataSource.query("DELETE FROM leaderboard_snapshots");
    await dataSource.query("DELETE FROM outbox");
    await dataSource.query(
      "UPDATE tournament_state SET phase = 'ACTIVE', finalized_at = NULL",
    );
    await new TournamentService(dataSource, [100, 50]).finalizeDue();

    await payouts.markPaid("tournament:default:payout:winner");

    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    expect(state).toEqual([{ phase: "PAYING" }]);
  });

  it("applies concurrent deliveries once", async () => {
    await Promise.all([
      payouts.markPaid("tournament:default:payout:winner"),
      payouts.markPaid("tournament:default:payout:winner"),
    ]);

    const payout = await dataSource.query(
      "SELECT status, attempts FROM payouts WHERE player_id = 'winner'",
    );
    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    expect(payout).toEqual([{ status: "PAID", attempts: 1 }]);
    expect(state).toEqual([{ phase: "PAID" }]);
  });

  it("does not change tournament state for an unknown payout", async () => {
    await expect(payouts.markPaid("unknown-payout")).rejects.toThrow(
      "Unknown payout",
    );

    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    expect(state).toEqual([{ phase: "PAYING" }]);
  });

  it("does not complete a tournament with a failed payout", async () => {
    await dataSource.query("UPDATE payouts SET status = 'FAILED'");

    await expect(
      payouts.markPaid("tournament:default:payout:winner"),
    ).rejects.toThrow("Payout is not payable");

    const state = await dataSource.query(
      "SELECT phase FROM tournament_state WHERE id = 1",
    );
    expect(state).toEqual([{ phase: "PAYING" }]);
  });
});
