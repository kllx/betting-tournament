import { DataSource, EntityManager } from "typeorm";
import { PermanentMessageError } from "../messaging/signed-internal.consumer";
import { MetricsService } from "../observability/metrics.service";

export class UnknownPayoutError extends PermanentMessageError {}
export class PayoutNotPayableError extends PermanentMessageError {}

export class PayoutService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics?: MetricsService,
  ) {}

  async markPaid(idempotencyKey: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        "SELECT id FROM tournament_state WHERE id = 1 FOR UPDATE",
      );
      const [updated] = await manager.query(
        `UPDATE payouts SET
           status = 'PAID', attempts = attempts + 1, paid_at = now(), last_error = NULL
         WHERE idempotency_key = $1 AND status = 'PENDING'
         RETURNING player_id`,
        [idempotencyKey],
      );
      if (updated.length === 0) {
        const existing = await manager.query(
          "SELECT status FROM payouts WHERE idempotency_key = $1",
          [idempotencyKey],
        );
        if (existing.length === 0) {
          throw new UnknownPayoutError(`Unknown payout: ${idempotencyKey}`);
        }
        if (existing[0].status !== "PAID") {
          throw new PayoutNotPayableError(
            `Payout is not payable: ${existing[0].status}`,
          );
        }
        this.metrics?.payoutConfirmed("DUPLICATE");
      } else {
        this.metrics?.payoutConfirmed("PAID");
      }
      await this.completeIfAllPaid(manager);
    });
  }

  private async completeIfAllPaid(manager: EntityManager): Promise<void> {
    const [completed] = await manager.query(`
      UPDATE tournament_state SET phase = 'PAID'
      WHERE phase = 'PAYING'
        AND NOT EXISTS (SELECT 1 FROM payouts WHERE status <> 'PAID')
      RETURNING floor(extract(epoch FROM finalized_at) * 1000000)::text AS version
    `);
    if (completed.length === 0) {
      return;
    }
    await manager.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ('tournament:default:paid', 'tournament.phase.changed', $1)`,
      [JSON.stringify({ phase: "PAID", version: completed[0].version })],
    );
  }
}
