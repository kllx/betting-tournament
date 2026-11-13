import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEventSecurity implements MigrationInterface {
  name = "SecurityHardening1763000003000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE bets ADD payload_hash varchar(64)");
    await queryRunner.query(
      "ALTER TABLE bet_events ADD payload_hash varchar(64)",
    );
    await queryRunner.query(
      "ALTER TABLE bet_events ALTER COLUMN event_id TYPE varchar(160)",
    );
    await queryRunner.query(
      "ALTER TABLE players ADD CONSTRAINT max_player_points CHECK (points <= 2000000000)",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE players DROP CONSTRAINT max_player_points",
    );
    await queryRunner.query("ALTER TABLE bet_events DROP COLUMN payload_hash");
    await queryRunner.query("ALTER TABLE bets DROP COLUMN payload_hash");
  }
}

export { AddEventSecurity as SecurityHardening };
