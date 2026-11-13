import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTournamentLifecycle implements MigrationInterface {
  name = "TournamentState1763000001000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE players
      ADD points_reached_at timestamptz NOT NULL DEFAULT now()
    `);
    await queryRunner.query(`
      CREATE TABLE tournament_state (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        phase varchar(16) NOT NULL CHECK (phase IN ('ACTIVE', 'PAYING', 'PAID')),
        ends_at timestamptz NOT NULL,
        settlement_cutoff_at timestamptz NOT NULL,
        finalize_at timestamptz NOT NULL,
        finalized_at timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE TABLE bet_events (
        event_id varchar(64) PRIMARY KEY,
        bet_id varchar(128) NOT NULL,
        event_type varchar(16) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL,
        reason varchar(64),
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      )
    `);
    await queryRunner.query(
      "CREATE INDEX idx_bet_events_bet_id ON bet_events (bet_id)",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE bet_events");
    await queryRunner.query("DROP TABLE tournament_state");
    await queryRunner.query(
      "ALTER TABLE players DROP COLUMN points_reached_at",
    );
  }
}

export { AddTournamentLifecycle as TournamentState };
