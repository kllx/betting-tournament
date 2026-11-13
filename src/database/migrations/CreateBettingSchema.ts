import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateBettingSchema implements MigrationInterface {
  name = "InitialSchema1763000000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE players (
        player_id varchar(128) PRIMARY KEY,
        points integer NOT NULL DEFAULT 0 CHECK (points >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE bets (
        bet_id varchar(128) PRIMARY KEY,
        player_id varchar(128) NOT NULL,
        currency varchar(3) NOT NULL,
        stake numeric NOT NULL CHECK (stake >= 0),
        win_amount numeric NOT NULL CHECK (win_amount >= 0),
        settled_at timestamptz NOT NULL,
        points integer NOT NULL CHECK (points >= 0),
        status varchar(16) NOT NULL CHECK (status IN ('settled', 'rolled_back'))
      )
    `);
    await queryRunner.query(
      "CREATE INDEX idx_bets_player_id ON bets (player_id)",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE bets");
    await queryRunner.query("DROP TABLE players");
  }
}

export { CreateBettingSchema as InitialSchema };
