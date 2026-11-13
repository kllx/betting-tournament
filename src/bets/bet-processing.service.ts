import { DataSource, EntityManager } from "typeorm";
import { LIMITS } from "../config/limits";
import { Money } from "../money";
import { FingerprintService } from "../observability/fingerprint.service";
import { MetricsService } from "../observability/metrics.service";
import { PointsCalculator } from "../scoring/points-calculator";
import {
  BetPayloadConflictError,
  EventPayloadConflictError,
} from "../security/fingerprint";
import { BetEvent } from "./bet-event";

export type BetEventType = "bet.settled" | "bet.rollback";
export type BetProcessingStatus = "processed" | "duplicate" | "ignored";

export interface BetProcessingResult {
  status: BetProcessingStatus;
  reason?: string;
}

interface TournamentStateRow {
  phase: string;
  ended: boolean;
  settlement_closed: boolean;
}

export class BetProcessingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly pointsCalculator: PointsCalculator,
    private readonly fingerprint = new FingerprintService(),
    private readonly metrics?: MetricsService,
  ) {}

  async process(
    type: BetEventType,
    event: BetEvent,
    eventId = `${type}:${event.betId}`,
    rawPayload?: string,
  ): Promise<BetProcessingResult> {
    const eventHash = this.fingerprint.event(
      type,
      rawPayload ?? JSON.stringify(event),
    );
    const betHash = this.fingerprint.bet(event);
    return this.fingerprint.trackBet(
      type,
      this.dataSource.transaction(async (manager) => {
        const insertedId = await manager.query(
          `WITH archived AS (
             SELECT event_id, event_type, payload_hash
             FROM bet_event_ids_archive WHERE event_id = $1
           ), inserted AS (
             INSERT INTO bet_event_ids (event_id, received_at, event_type, payload_hash)
             SELECT $1, now(), $2, $3
             WHERE NOT EXISTS (
               SELECT 1 FROM bet_event_ids_archive WHERE event_id = $1
             )
             ON CONFLICT (event_id) DO NOTHING
             RETURNING event_id, event_type, payload_hash
           )
           SELECT event_id, event_type, payload_hash, 'fresh' AS source FROM inserted
           UNION ALL
           SELECT event_id, event_type, payload_hash, 'archived' AS source FROM archived`,
          [eventId, type, eventHash],
        );
        if (insertedId[0]?.source === "archived") {
          if (
            insertedId[0].event_type !== type ||
            insertedId[0].payload_hash !== eventHash
          ) {
            throw new EventPayloadConflictError("Event payload conflict");
          }
          return { status: "duplicate", reason: "duplicate_event" };
        }
        if (insertedId.length === 0) {
          await this.assertEventPayload(
            manager,
            type,
            event,
            eventId,
            eventHash,
          );
          return { status: "duplicate", reason: "duplicate_event" };
        }
        const insertedEvent = await manager.query(
          `INSERT INTO bet_events (
            event_id, bet_id, event_type, payload, payload_hash, status
          ) VALUES ($1, $2, $3, $4, $5, 'received')
          RETURNING received_at::text AS received_at`,
          [eventId, event.betId, type, JSON.stringify(event), eventHash],
        );
        const receivedAt = insertedEvent[0].received_at as string;

        await this.assertBetPayload(manager, event, betHash);
        const states: TournamentStateRow[] = await manager.query(
          `SELECT phase,
                now() >= ends_at AS ended,
                now() >= settlement_cutoff_at AS settlement_closed
         FROM tournament_state WHERE id = 1 FOR SHARE`,
        );
        if (states.length === 0) {
          throw new Error("Tournament state is not initialized");
        }
        const state = states[0];
        if (state.phase !== "ACTIVE") {
          return this.ignore(
            manager,
            eventId,
            receivedAt,
            "tournament_finalized",
          );
        }
        if (type === "bet.rollback" && state.ended) {
          return this.ignore(
            manager,
            eventId,
            receivedAt,
            "after_tournament_end",
          );
        }
        if (type === "bet.settled" && state.settlement_closed) {
          return this.ignore(
            manager,
            eventId,
            receivedAt,
            "after_settlement_cutoff",
          );
        }

        if (type === "bet.rollback") {
          return this.rollback(manager, event, eventId, receivedAt, betHash);
        }
        return this.settle(manager, event, eventId, receivedAt, betHash);
      }),
    );
  }

  private async settle(
    manager: EntityManager,
    event: BetEvent,
    eventId: string,
    receivedAt: string,
    betHash: string,
  ): Promise<BetProcessingResult> {
    const existing = await manager.query(
      "SELECT bet_id FROM bets WHERE bet_id = $1",
      [event.betId],
    );
    if (existing.length > 0) {
      await this.assertBetPayload(manager, event, betHash);
      return this.ignore(manager, eventId, receivedAt, "duplicate_bet");
    }

    const points = this.pointsCalculator.calculate(
      event.winAmount,
      event.currency,
    );
    const inserted = await manager.query(
      `INSERT INTO bets (
        bet_id, player_id, currency, stake, win_amount, settled_at,
        points, status, payload_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'settled', $7)
      ON CONFLICT (bet_id) DO NOTHING
      RETURNING bet_id`,
      [
        event.betId,
        event.playerId,
        event.currency,
        Money.from(event.stake).toString(),
        Money.from(event.winAmount).toString(),
        event.settledAt,
        betHash,
      ],
    );
    if (inserted.length === 0) {
      await this.assertBetPayload(manager, event, betHash);
      return this.ignore(manager, eventId, receivedAt, "duplicate_bet");
    }
    const ensured = await manager.query(
      `INSERT INTO players (player_id, points) VALUES ($1, 0)
       ON CONFLICT (player_id) DO NOTHING
       RETURNING player_id, points`,
      [event.playerId],
    );
    const current =
      ensured.length > 0
        ? ensured[0]
        : (
            await manager.query(
              "SELECT points FROM players WHERE player_id = $1 FOR UPDATE",
              [event.playerId],
            )
          )[0];
    const awarded = Math.min(
      points,
      Math.max(LIMITS.MAX_PLAYER_POINTS - Number(current.points), 0),
    );
    await manager.query("UPDATE bets SET points = $2 WHERE bet_id = $1", [
      event.betId,
      awarded,
    ]);

    const [projected] = await manager.query(
      `UPDATE players SET
         points = points + $2,
         points_reached_at = CASE
           WHEN $2 > 0 THEN clock_timestamp() ELSE players.points_reached_at END,
         score_version = nextval('tournament_score_version_seq')
       WHERE player_id = $1
       RETURNING points, points_reached_at, score_version,
         floor(extract(epoch FROM points_reached_at) * 1000000)::bigint AS points_reached_at_us`,
      [event.playerId, awarded],
    );
    if (awarded < points) {
      this.metrics?.scoreCapped();
    }
    await manager.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ($1, 'player.score.changed', $2)`,
      [
        `score:${eventId}`,
        JSON.stringify({
          playerId: event.playerId,
          points: projected[0].points,
          pointsReachedAt: projected[0].points_reached_at,
          pointsReachedAtUs: projected[0].points_reached_at_us,
          scoreVersion: projected[0].score_version,
        }),
      ],
    );
    await this.markProcessed(manager, eventId, receivedAt);
    return { status: "processed" };
  }

  private async rollback(
    manager: EntityManager,
    event: BetEvent,
    eventId: string,
    receivedAt: string,
    betHash: string,
  ): Promise<BetProcessingResult> {
    const inserted = await manager.query(
      `INSERT INTO bets (
        bet_id, player_id, currency, stake, win_amount, settled_at,
        points, status, payload_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'rolled_back', $7)
      ON CONFLICT (bet_id) DO NOTHING
      RETURNING bet_id`,
      [
        event.betId,
        event.playerId,
        event.currency,
        Money.from(event.stake).toString(),
        Money.from(event.winAmount).toString(),
        event.settledAt,
        betHash,
      ],
    );
    if (inserted.length > 0) {
      await this.markProcessed(manager, eventId, receivedAt);
      return { status: "processed" };
    }
    await this.assertBetPayload(manager, event, betHash);

    const [updated] = await manager.query(
      `UPDATE bets SET status = 'rolled_back'
       WHERE bet_id = $1 AND status = 'settled'
       RETURNING player_id, points`,
      [event.betId],
    );
    if (updated.length === 0) {
      await this.markDuplicate(
        manager,
        eventId,
        receivedAt,
        "bet_already_rolled_back",
      );
      return { status: "duplicate", reason: "bet_already_rolled_back" };
    }

    const [projected] = await manager.query(
      `UPDATE players SET
         points = points - $2,
         points_reached_at = CASE
           WHEN $2 > 0 THEN clock_timestamp() ELSE points_reached_at END,
         score_version = nextval('tournament_score_version_seq')
       WHERE player_id = $1
       RETURNING points, points_reached_at, score_version,
         floor(extract(epoch FROM points_reached_at) * 1000000)::bigint AS points_reached_at_us`,
      [updated[0].player_id, updated[0].points],
    );
    await manager.query(
      `INSERT INTO outbox (event_id, event_type, payload)
       VALUES ($1, 'player.score.changed', $2)`,
      [
        `score:${eventId}`,
        JSON.stringify({
          playerId: updated[0].player_id,
          points: projected[0].points,
          pointsReachedAt: projected[0].points_reached_at,
          pointsReachedAtUs: projected[0].points_reached_at_us,
          scoreVersion: projected[0].score_version,
        }),
      ],
    );
    await this.markProcessed(manager, eventId, receivedAt);
    return { status: "processed" };
  }

  private async assertEventPayload(
    manager: EntityManager,
    type: BetEventType,
    event: BetEvent,
    eventId: string,
    eventHash: string,
  ): Promise<void> {
    const existing = await manager.query(
      `SELECT ids.event_type, be.payload,
              COALESCE(be.payload_hash, ids.payload_hash) AS payload_hash
       FROM bet_event_ids AS ids
       LEFT JOIN bet_events AS be
         ON be.event_id = ids.event_id AND be.received_at = ids.received_at
       WHERE ids.event_id = $1`,
      [eventId],
    );
    const stored = existing[0];
    if (stored.payload_hash) {
      if (stored.event_type !== type || stored.payload_hash !== eventHash) {
        throw new EventPayloadConflictError("Event payload conflict");
      }
      return;
    }
    if (
      stored.event_type !== type ||
      !stored.payload ||
      !this.sameStoredPayload(stored.payload, event)
    ) {
      throw new EventPayloadConflictError("Event payload conflict");
    }
    await manager.query(
      "UPDATE bet_event_ids SET payload_hash = $2 WHERE event_id = $1",
      [eventId, eventHash],
    );
    await manager.query(
      `UPDATE bet_events AS be SET payload_hash = $2
       FROM bet_event_ids AS ids
       WHERE ids.event_id = $1
         AND be.event_id = ids.event_id
         AND be.received_at = ids.received_at`,
      [eventId, eventHash],
    );
  }

  private async assertBetPayload(
    manager: EntityManager,
    event: BetEvent,
    betHash: string,
  ): Promise<void> {
    const existing = await manager.query(
      `SELECT player_id, currency, stake, win_amount, settled_at, payload_hash
       FROM bets WHERE bet_id = $1`,
      [event.betId],
    );
    const stored = existing[0];
    if (!stored) {
      return;
    }
    if (stored.payload_hash && stored.payload_hash !== betHash) {
      throw new BetPayloadConflictError("Bet payload conflict");
    }
    if (!stored.payload_hash) {
      if (!this.sameStoredBet(stored, event)) {
        throw new BetPayloadConflictError("Bet payload conflict");
      }
      await manager.query(
        "UPDATE bets SET payload_hash = $2 WHERE bet_id = $1",
        [event.betId, betHash],
      );
    }
  }

  private sameStoredPayload(
    stored: Record<string, unknown>,
    event: BetEvent,
  ): boolean {
    return (
      stored.betId === event.betId &&
      stored.playerId === event.playerId &&
      stored.currency === event.currency &&
      Money.from(String(stored.stake)).equals(Money.from(event.stake)) &&
      Money.from(String(stored.winAmount)).equals(
        Money.from(event.winAmount),
      ) &&
      stored.settledAt === event.settledAt
    );
  }

  private sameStoredBet(
    stored: Record<string, unknown>,
    event: BetEvent,
  ): boolean {
    return (
      stored.player_id === event.playerId &&
      stored.currency === event.currency &&
      Money.from(String(stored.stake)).equals(Money.from(event.stake)) &&
      Money.from(String(stored.win_amount)).equals(
        Money.from(event.winAmount),
      ) &&
      new Date(String(stored.settled_at)).getTime() ===
        Date.parse(event.settledAt)
    );
  }

  private async ignore(
    manager: EntityManager,
    eventId: string,
    receivedAt: string,
    reason: string,
  ): Promise<BetProcessingResult> {
    const [updated] = await manager.query(
      `UPDATE bet_events SET status = 'ignored', reason = $3, processed_at = now()
       WHERE event_id = $1 AND received_at = $2
       RETURNING event_id`,
      [eventId, receivedAt, reason],
    );
    if (updated.length !== 1) {
      throw new Error("Bet event state update failed");
    }
    return { status: "ignored", reason };
  }

  private async markDuplicate(
    manager: EntityManager,
    eventId: string,
    receivedAt: string,
    reason: string,
  ): Promise<void> {
    const [updated] = await manager.query(
      `UPDATE bet_events SET status = 'duplicate', reason = $3, processed_at = now()
       WHERE event_id = $1 AND received_at = $2
       RETURNING event_id`,
      [eventId, receivedAt, reason],
    );
    if (updated.length !== 1) {
      throw new Error("Bet event state update failed");
    }
  }

  private async markProcessed(
    manager: EntityManager,
    eventId: string,
    receivedAt: string,
  ): Promise<void> {
    const [updated] = await manager.query(
      `UPDATE bet_events SET status = 'processed', processed_at = now()
       WHERE event_id = $1 AND received_at = $2
       RETURNING event_id`,
      [eventId, receivedAt],
    );
    if (updated.length !== 1) {
      throw new Error("Bet event state update failed");
    }
  }
}
