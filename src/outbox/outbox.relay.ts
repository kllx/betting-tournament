import { DataSource } from "typeorm";
import { MetricsService } from "../observability/metrics.service";
import { runWithConcurrency } from "../utils/run-with-concurrency";

export interface OutboxPublisher {
  publish(eventType: string, payload: unknown, eventId: string): Promise<void>;
}

interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
}

interface OutboxOutcome {
  record: OutboxRow;
  error?: unknown;
}

export class OutboxRelay {
  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: OutboxPublisher,
    private readonly batchSize: number,
    private readonly metrics: MetricsService | undefined,
    private readonly publishConcurrency: number,
    private readonly maxAttempts: number,
  ) {}

  async flush(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const records: OutboxRow[] = await manager.query(
        `SELECT id, event_id, event_type, payload
         FROM outbox
         WHERE status = 'NEW' AND available_at <= now()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );

      const outcomes = await runWithConcurrency(
        records,
        this.publishConcurrency,
        async (record): Promise<OutboxOutcome> => {
          try {
            await this.publisher.publish(
              record.event_type,
              record.payload,
              record.event_id,
            );
            return { record };
          } catch (error) {
            return { record, error };
          }
        },
      );

      for (const outcome of outcomes) {
        const { record, error } = outcome;
        if (error === undefined) {
          await manager.query(
            `UPDATE outbox SET status = 'PUBLISHED', published_at = now(), last_error = NULL
             WHERE id = $1`,
            [record.id],
          );
          this.metrics?.outboxPublished(record.event_type, "PUBLISHED");
        } else {
          this.metrics?.outboxPublished(record.event_type, "ERROR");
          await manager.query(
            `UPDATE outbox SET
               attempts = attempts + 1,
               status = CASE WHEN attempts + 1 >= $3 THEN 'FAILED' ELSE 'NEW' END,
               available_at = now() + interval '1 second' * LEAST(60, attempts + 1),
               last_error = $2
             WHERE id = $1`,
            [
              record.id,
              error instanceof Error ? error.message : "Unknown publish error",
              this.maxAttempts,
            ],
          );
        }
      }
    });
  }
}
