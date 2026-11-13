import { MigrationInterface, QueryRunner } from "typeorm";

export class AddArchiveRetention implements MigrationInterface {
  name = "ArchiveRetention1763000008000";
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bet_event_ids_archive_received_at ON bet_event_ids_archive (received_at, event_id)",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DROP INDEX CONCURRENTLY IF EXISTS idx_bet_event_ids_archive_received_at",
    );
  }
}

export { AddArchiveRetention as ArchiveRetention };
