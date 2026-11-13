import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDedupRetention implements MigrationInterface {
  name = "DedupRetention1763000007000";
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS bet_event_ids_archive (
        event_id varchar(256) PRIMARY KEY,
        received_at timestamptz NOT NULL,
        event_type varchar(16),
        payload_hash varchar(64)
      )
    `);
    await queryRunner.query(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bet_event_ids_received_at ON bet_event_ids (received_at, event_id)",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO bet_event_ids (event_id, received_at, event_type, payload_hash)
      SELECT event_id, received_at, event_type, payload_hash
      FROM bet_event_ids_archive
      ON CONFLICT (event_id) DO NOTHING
    `);
    await queryRunner.query("DROP TABLE bet_event_ids_archive");
    await queryRunner.query(
      "DROP INDEX CONCURRENTLY IF EXISTS idx_bet_event_ids_received_at",
    );
  }
}

export { AddDedupRetention as DedupRetention };
