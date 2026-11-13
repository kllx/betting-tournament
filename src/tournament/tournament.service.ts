import { DataSource } from "typeorm";
import { Money, MoneyInput } from "../money";

export type TournamentPhase = "ACTIVE" | "PAYING" | "PAID";

export interface FinalizationResult {
  finalized: boolean;
  phase: TournamentPhase;
}

interface TournamentStateRow {
  phase: TournamentPhase;
  due: boolean;
}

export class TournamentService {
  private readonly prizes: Money[];

  constructor(
    private readonly dataSource: DataSource,
    prizes: MoneyInput[],
  ) {
    this.prizes = prizes.map((prize) => Money.from(prize));
  }

  async finalizeDue(): Promise<FinalizationResult> {
    return this.dataSource.transaction(async (manager) => {
      const states: TournamentStateRow[] = await manager.query(
        `SELECT phase, now() >= finalize_at AS due
         FROM tournament_state WHERE id = 1`,
      );
      if (states.length === 0) {
        throw new Error("Tournament state is not initialized");
      }
      const state = states[0];
      if (state.phase !== "ACTIVE") {
        return { finalized: true, phase: state.phase };
      }
      if (!state.due) {
        return { finalized: false, phase: state.phase };
      }
      const lockedStates: TournamentStateRow[] = await manager.query(
        `SELECT phase, now() >= finalize_at AS due
         FROM tournament_state WHERE id = 1 FOR UPDATE`,
      );
      if (lockedStates[0].phase !== "ACTIVE") {
        return { finalized: true, phase: lockedStates[0].phase };
      }
      if (!lockedStates[0].due) {
        return { finalized: false, phase: lockedStates[0].phase };
      }

      await manager.query(`
        INSERT INTO leaderboard_snapshots (player_id, rank, points, points_reached_at)
        SELECT player_id,
               ROW_NUMBER() OVER (
                 ORDER BY points DESC, points_reached_at ASC, player_id DESC
               ) AS rank,
               points,
               points_reached_at
        FROM players
      `);
      const winners = await manager.query(
        `WITH ranked AS (
           SELECT player_id, points, points_reached_at,
                  ROW_NUMBER() OVER (
                    ORDER BY points DESC, points_reached_at ASC, player_id DESC
                  ) AS rank
           FROM players
           WHERE points > 0
         )
         INSERT INTO tournament_winners (
           player_id, rank, points, points_reached_at, prize_amount, prize_currency
         )
         SELECT ranked.player_id, ranked.rank, ranked.points,
                ranked.points_reached_at, prizes.prize, 'USD'
         FROM ranked
         JOIN unnest($1::numeric[]) WITH ORDINALITY AS prizes(prize, rank)
           ON prizes.rank = ranked.rank
         RETURNING player_id`,
        [this.prizes.map((prize) => prize.toString())],
      );
      await manager.query(`
        INSERT INTO payouts (
          player_id, idempotency_key, rank, amount, currency, status
        )
        SELECT player_id,
               'tournament:default:payout:' || player_id,
               rank,
               prize_amount,
               'USD',
               'PENDING'
        FROM tournament_winners
      `);
      await manager.query(`
        INSERT INTO outbox (event_id, event_type, payload)
        SELECT 'payout:' || player_id,
               'payout.requested',
               jsonb_build_object(
                 'payoutId', idempotency_key,
                 'playerId', player_id,
                 'rank', rank,
                 'amount', amount::text,
                 'currency', currency
               )
        FROM payouts
      `);

      const phase: TournamentPhase = winners.length > 0 ? "PAYING" : "PAID";
      const [finalized] = await manager.query(
        `UPDATE tournament_state SET phase = $1, finalized_at = now()
         WHERE id = 1
         RETURNING floor(extract(epoch FROM finalized_at) * 1000000)::text AS version`,
        [phase],
      );
      await manager.query(
        `INSERT INTO outbox (event_id, event_type, payload)
         VALUES ('tournament:default:phase', 'tournament.phase.changed', $1)`,
        [
          JSON.stringify({
            phase,
            version: finalized[0].version,
          }),
        ],
      );
      return { finalized: true, phase };
    });
  }
}
