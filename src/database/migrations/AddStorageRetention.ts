import { MigrationInterface, QueryRunner } from "typeorm";

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function cutoverBetEvents(
  queryRunner: QueryRunner,
): Promise<void> {
  const existing = await queryRunner.query(
    "SELECT relkind FROM pg_class WHERE oid = 'bet_events'::regclass",
  );
  if (existing[0]?.relkind === "p") {
    return;
  }
  const ready = await queryRunner.query(
    "SELECT id FROM bet_event_migration_state WHERE id = 1 AND completed = true",
  );
  if (ready.length === 0) {
    throw new Error("Bet events backfill is not complete");
  }
  await queryRunner.startTransaction();
  try {
    await queryRunner.query("LOCK TABLE bet_events IN ACCESS EXCLUSIVE MODE");
    await queryRunner.query(
      "ALTER TABLE bet_events RENAME TO bet_events_legacy",
    );
    await queryRunner.query("ALTER TABLE bet_events_new RENAME TO bet_events");
    await queryRunner.query("DROP TABLE bet_events_legacy");
    await queryRunner.query("DROP FUNCTION bet_events_replicate");
    await queryRunner.query("DROP TABLE bet_event_migration_state");
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  }
}

export class AddStorageRetention implements MigrationInterface {
  name = "StorageRetention1763000005000";
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const existing = await queryRunner.query(
      "SELECT relkind FROM pg_class WHERE oid = 'bet_events'::regclass",
    );
    if (existing[0]?.relkind === "p") {
      return;
    }
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bet_event_ids (
        event_id varchar(256) PRIMARY KEY,
        received_at timestamptz NOT NULL,
        event_type varchar(16),
        payload_hash varchar(64)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bet_event_migration_state (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        event_id varchar(256) NOT NULL DEFAULT '',
        completed boolean NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(
      "INSERT INTO bet_event_migration_state (id) VALUES (1) ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bet_events_new (
        event_id varchar(256) NOT NULL,
        bet_id varchar(128) NOT NULL,
        event_type varchar(16) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL,
        reason varchar(64),
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        payload_hash varchar(64),
        PRIMARY KEY (event_id, received_at)
      ) PARTITION BY RANGE (received_at)
    `);
    await queryRunner.query(
      "CREATE INDEX IF NOT EXISTS idx_bet_events_new_bet_id ON bet_events_new (bet_id)",
    );
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const afterTomorrow = new Date(tomorrow);
    afterTomorrow.setUTCDate(afterTomorrow.getUTCDate() + 1);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bet_events_before_today PARTITION OF bet_events_new
      FOR VALUES FROM (MINVALUE) TO ('${dateString(today)}')
    `);
    await this.createPartition(queryRunner, today, tomorrow);
    await this.createPartition(queryRunner, tomorrow, afterTomorrow);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION bet_events_replicate() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM bet_events_new
          WHERE event_id = OLD.event_id AND received_at = OLD.received_at;
          DELETE FROM bet_event_ids WHERE event_id = OLD.event_id;
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          DELETE FROM bet_events_new
          WHERE event_id = OLD.event_id AND received_at = OLD.received_at;
        END IF;
        INSERT INTO bet_event_ids (event_id, received_at, event_type, payload_hash)
        VALUES (NEW.event_id, NEW.received_at, NEW.event_type, NEW.payload_hash)
        ON CONFLICT (event_id) DO UPDATE SET
          received_at = EXCLUDED.received_at,
          event_type = EXCLUDED.event_type,
          payload_hash = EXCLUDED.payload_hash;
        INSERT INTO bet_events_new (
          event_id, bet_id, event_type, payload, status, reason,
          received_at, processed_at, payload_hash
        ) VALUES (
          NEW.event_id, NEW.bet_id, NEW.event_type, NEW.payload, NEW.status,
          NEW.reason, NEW.received_at, NEW.processed_at, NEW.payload_hash
        )
        ON CONFLICT (event_id, received_at) DO UPDATE SET
          bet_id = EXCLUDED.bet_id,
          event_type = EXCLUDED.event_type,
          payload = EXCLUDED.payload,
          status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          processed_at = EXCLUDED.processed_at,
          payload_hash = EXCLUDED.payload_hash;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(
      "DROP TRIGGER IF EXISTS bet_events_replicate_trigger ON bet_events",
    );
    await queryRunner.query(`
      CREATE TRIGGER bet_events_replicate_trigger
      AFTER INSERT OR UPDATE OR DELETE ON bet_events
      FOR EACH ROW EXECUTE FUNCTION bet_events_replicate()
    `);

    let lastEventId = "";
    while (true) {
      const rows = await queryRunner.query(
        `SELECT event_id FROM bet_events
         WHERE event_id > $1 ORDER BY event_id LIMIT 10000`,
        [lastEventId],
      );
      if (rows.length === 0) {
        break;
      }
      const previousEventId = lastEventId;
      lastEventId = rows[rows.length - 1].event_id;
      await queryRunner.query(
        `INSERT INTO bet_event_ids (event_id, received_at, event_type, payload_hash)
         SELECT event_id, received_at, event_type, payload_hash FROM bet_events
         WHERE event_id > $1 AND event_id <= $2
         ORDER BY event_id
         ON CONFLICT (event_id) DO NOTHING`,
        [previousEventId, lastEventId],
      );
      await queryRunner.query(
        `INSERT INTO bet_events_new (
          event_id, bet_id, event_type, payload, status, reason,
          received_at, processed_at, payload_hash
        )
        SELECT event_id, bet_id, event_type, payload, status, reason,
               received_at, processed_at, payload_hash
        FROM bet_events
        WHERE event_id > $1 AND event_id <= $2
        ORDER BY event_id
        ON CONFLICT (event_id, received_at) DO NOTHING`,
        [previousEventId, lastEventId],
      );
      await queryRunner.query(
        "UPDATE bet_event_migration_state SET event_id = $1 WHERE id = 1",
        [lastEventId],
      );
    }

    await queryRunner.query(
      "UPDATE bet_event_migration_state SET completed = true WHERE id = 1",
    );
    if (process.env.BET_EVENTS_DEFER_CUTOVER !== "true") {
      await cutoverBetEvents(queryRunner);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        "ALTER TABLE bet_events RENAME TO bet_events_partitioned",
      );
      await queryRunner.query(
        "ALTER TABLE bet_events_partitioned RENAME CONSTRAINT bet_events_new_pkey TO bet_events_partitioned_pkey",
      );
      await queryRunner.query(
        "ALTER INDEX idx_bet_events_new_bet_id RENAME TO idx_bet_events_partitioned_bet_id",
      );
      await queryRunner.query(`
        CREATE TABLE bet_events (
          event_id varchar(256) PRIMARY KEY,
          bet_id varchar(128) NOT NULL,
          event_type varchar(16) NOT NULL,
          payload jsonb NOT NULL,
          status varchar(16) NOT NULL,
          reason varchar(64),
          received_at timestamptz NOT NULL DEFAULT now(),
          processed_at timestamptz,
          payload_hash varchar(64)
        )
      `);
      await queryRunner.query(`
        INSERT INTO bet_events (
          event_id, bet_id, event_type, payload, status, reason,
          received_at, processed_at, payload_hash
        )
        SELECT event_id, bet_id, event_type, payload, status, reason,
               received_at, processed_at, payload_hash
        FROM bet_events_partitioned
      `);
      await queryRunner.query(
        "CREATE INDEX idx_bet_events_bet_id ON bet_events (bet_id)",
      );
      await queryRunner.query("DROP TABLE bet_events_partitioned");
      await queryRunner.query("DROP TABLE bet_event_ids");
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    }
  }

  private async createPartition(
    queryRunner: QueryRunner,
    from: Date,
    to: Date,
  ): Promise<void> {
    const name = `bet_events_${dateString(from).replaceAll("-", "_")}`;
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${name} PARTITION OF bet_events_new
      FOR VALUES FROM ('${dateString(from)}') TO ('${dateString(to)}')
    `);
  }
}

export { AddStorageRetention as StorageRetention };
