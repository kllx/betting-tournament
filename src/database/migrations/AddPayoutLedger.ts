import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPayoutLedger implements MigrationInterface {
  name = "TournamentFinalization1763000002000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tournament_winners (
        player_id varchar(128) PRIMARY KEY,
        rank integer NOT NULL UNIQUE,
        points integer NOT NULL,
        points_reached_at timestamptz NOT NULL,
        prize_amount numeric NOT NULL,
        prize_currency varchar(3) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE payouts (
        player_id varchar(128) PRIMARY KEY,
        idempotency_key varchar(256) NOT NULL UNIQUE,
        rank integer NOT NULL,
        amount numeric NOT NULL CHECK (amount > 0),
        currency varchar(3) NOT NULL,
        status varchar(16) NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED')),
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        paid_at timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE TABLE outbox (
        id bigserial PRIMARY KEY,
        event_id varchar(256) NOT NULL UNIQUE,
        event_type varchar(64) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'NEW'
          CHECK (status IN ('NEW', 'PUBLISHED', 'FAILED')),
        attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz,
        last_error text
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_outbox_pending ON outbox (id)
      WHERE status = 'NEW'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE outbox");
    await queryRunner.query("DROP TABLE payouts");
    await queryRunner.query("DROP TABLE tournament_winners");
  }
}

export { AddPayoutLedger as TournamentFinalization };
