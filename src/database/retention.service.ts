import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { waitForDrain } from "../messaging/drain";

interface PartitionRow {
  name: string;
  bounds: string;
}

const RETENTION_LOCK_ID = 1749238501;

@Injectable()
export class StorageRetentionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StorageRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.pending = this.run();
    this.timer = setInterval(() => {
      if (!this.running) {
        this.pending = this.run();
      }
    }, this.config.getOrThrow<number>("retention.cleanupIntervalMs"));
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await waitForDrain(
      [this.pending],
      this.config.getOrThrow<number>("shutdown.workerDrainTimeoutMs"),
    );
  }

  async runOnce(): Promise<void> {
    await this.cleanupOutbox();
    await this.cleanupBetEventIds();
    await this.cleanupBetEventIdsArchive();
    await this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock($1)", [
        RETENTION_LOCK_ID,
      ]);
      await this.ensureBetEventPartitions(manager);
      await this.dropExpiredBetEventPartitions(manager);
    });
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error("Storage retention failed", error);
    } finally {
      this.running = false;
    }
  }

  private async cleanupBetEventIds(): Promise<void> {
    const retentionDays = this.config.getOrThrow<number>(
      "retention.betEventIdsDays",
    );
    const batchSize = this.config.getOrThrow<number>("retention.batchSize");
    while (true) {
      const archived = await this.dataSource.query(
        `WITH victims AS (
           SELECT event_id FROM bet_event_ids
           WHERE received_at < now() - $1 * interval '1 day'
           ORDER BY received_at, event_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ), archived AS (
           INSERT INTO bet_event_ids_archive (event_id, received_at, event_type, payload_hash)
           SELECT event_id, received_at, event_type, payload_hash
           FROM bet_event_ids WHERE event_id IN (SELECT event_id FROM victims)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id
         ), deleted AS (
           DELETE FROM bet_event_ids WHERE event_id IN (SELECT event_id FROM victims)
           RETURNING event_id
         )
         SELECT event_id FROM deleted`,
        [retentionDays, batchSize],
      );
      if (archived.length < batchSize) {
        return;
      }
    }
  }

  private async cleanupBetEventIdsArchive(): Promise<void> {
    const retentionDays = this.config.getOrThrow<number>(
      "retention.betEventIdsArchiveDays",
    );
    const batchSize = this.config.getOrThrow<number>("retention.batchSize");
    while (true) {
      const deleted = await this.dataSource.query(
        `WITH victims AS (
           SELECT event_id FROM bet_event_ids_archive
           WHERE received_at < now() - $1 * interval '1 day'
           ORDER BY received_at, event_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ), deleted AS (
           DELETE FROM bet_event_ids_archive
           WHERE event_id IN (SELECT event_id FROM victims)
           RETURNING event_id
         )
         SELECT event_id FROM deleted`,
        [retentionDays, batchSize],
      );
      if (deleted.length < batchSize) {
        return;
      }
    }
  }

  private async cleanupOutbox(): Promise<void> {
    const retentionDays = this.config.getOrThrow<number>(
      "retention.outboxDays",
    );
    const batchSize = this.config.getOrThrow<number>("retention.batchSize");
    while (true) {
      const deleted = await this.dataSource.query(
        `WITH victims AS (
           SELECT id FROM outbox
           WHERE status = 'PUBLISHED'
             AND published_at < now() - $1 * interval '1 day'
           ORDER BY published_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ), deleted AS (
           DELETE FROM outbox AS o USING victims AS v
           WHERE o.id = v.id
           RETURNING o.id
         )
         SELECT id FROM deleted`,
        [retentionDays, batchSize],
      );
      if (deleted.length < batchSize) {
        return;
      }
    }
  }

  private async ensureBetEventPartitions(
    manager: EntityManager,
  ): Promise<void> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const afterTomorrow = new Date(tomorrow);
    afterTomorrow.setUTCDate(afterTomorrow.getUTCDate() + 1);
    await this.createPartition(manager, today, tomorrow);
    await this.createPartition(manager, tomorrow, afterTomorrow);
  }

  private async createPartition(
    manager: EntityManager,
    from: Date,
    to: Date,
  ): Promise<void> {
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = to.toISOString().slice(0, 10);
    const name = `bet_events_${fromDate.replaceAll("-", "_")}`;
    await manager.query(`
      CREATE TABLE IF NOT EXISTS ${name} PARTITION OF bet_events
      FOR VALUES FROM ('${fromDate}') TO ('${toDate}')
    `);
  }

  private async dropExpiredBetEventPartitions(
    manager: EntityManager,
  ): Promise<void> {
    const retentionDays = this.config.getOrThrow<number>(
      "retention.betEventsDays",
    );
    const cutoff = new Date();
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const partitions: PartitionRow[] = await manager.query(`
      SELECT child.relname AS name,
             pg_get_expr(child.relpartbound, child.oid) AS bounds
      FROM pg_inherits
      JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
      WHERE pg_inherits.inhparent = 'bet_events'::regclass
    `);
    for (const partition of partitions) {
      if (!/^bet_events_[a-z0-9_]+$/.test(partition.name)) {
        continue;
      }
      const upperBound = /TO \('([^']+)'\)/.exec(partition.bounds)?.[1];
      if (upperBound && upperBound.slice(0, 10) <= cutoffDate) {
        await manager.query(`DROP TABLE "${partition.name}"`);
      }
    }
  }
}
