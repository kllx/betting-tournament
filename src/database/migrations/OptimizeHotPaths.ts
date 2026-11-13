import { MigrationInterface, QueryRunner } from "typeorm";

export class OptimizeHotPaths implements MigrationInterface {
  name = "OptimizeHotPaths1763000006000";
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DROP INDEX CONCURRENTLY IF EXISTS idx_players_score_version",
    );
    await queryRunner.query(
      "DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_published_retention",
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY idx_outbox_published_retention
      ON outbox (published_at, id)
      WHERE status = 'PUBLISHED'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_published_retention",
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY idx_outbox_published_retention
      ON outbox (published_at, id)
      WHERE status = 'PUBLISHED'
    `);
    await queryRunner.query(
      "CREATE INDEX CONCURRENTLY idx_players_score_version ON players (score_version)",
    );
  }
}
