import { MigrationInterface, QueryRunner } from "typeorm";
import { fingerprintLegacyBet } from "../legacy-fingerprint";

export class AddScoreRevisions implements MigrationInterface {
  name = "ReviewHardening1763000004000";
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE bet_events ALTER COLUMN event_id TYPE varchar(256)",
    );
    await queryRunner.query(
      "ALTER TABLE outbox ALTER COLUMN event_id TYPE varchar(300)",
    );
    await queryRunner.query("CREATE SEQUENCE tournament_score_version_seq");
    await queryRunner.query(`
      SELECT setval(
        'tournament_score_version_seq',
        floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
      )
    `);
    await queryRunner.query("ALTER TABLE players ADD score_version bigint");
    let lastPlayerId = "";
    while (true) {
      const players = await queryRunner.query(
        `SELECT player_id FROM players
         WHERE score_version IS NULL AND player_id > $1
         ORDER BY player_id LIMIT 1000`,
        [lastPlayerId],
      );
      if (players.length === 0) {
        break;
      }
      lastPlayerId = players[players.length - 1].player_id;
      await queryRunner.query(
        `UPDATE players SET score_version = nextval('tournament_score_version_seq')
         WHERE player_id <= $1 AND score_version IS NULL`,
        [lastPlayerId],
      );
    }
    await queryRunner.query(
      "ALTER TABLE players ALTER COLUMN score_version SET NOT NULL",
    );
    await queryRunner.query(
      "ALTER TABLE players ALTER COLUMN score_version SET DEFAULT nextval('tournament_score_version_seq')",
    );
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY idx_players_ranking
      ON players (points DESC, points_reached_at ASC, player_id DESC)
    `);
    await queryRunner.query(`
      CREATE TABLE leaderboard_snapshots (
        player_id varchar(128) PRIMARY KEY,
        rank integer NOT NULL UNIQUE,
        points integer NOT NULL,
        points_reached_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    let lastBetId = "";
    while (true) {
      const bets = await queryRunner.query(
        `SELECT b.bet_id, be.payload
         FROM bets b
         LEFT JOIN LATERAL (
           SELECT payload FROM bet_events
           WHERE bet_id = b.bet_id
             AND event_type = 'bet.settled'
             AND status = 'processed'
           ORDER BY received_at ASC, event_id ASC
           LIMIT 1
         ) be ON true
         WHERE b.payload_hash IS NULL AND b.bet_id > $1
         ORDER BY b.bet_id
         LIMIT 1000`,
        [lastBetId],
      );
      if (bets.length === 0) {
        break;
      }
      const values: string[] = [];
      const parameters: string[] = [];
      for (const bet of bets) {
        const hash = fingerprintLegacyBet(bet.payload);
        if (hash) {
          values.push(`($${parameters.length + 1}, $${parameters.length + 2})`);
          parameters.push(hash, bet.bet_id);
        }
        lastBetId = bet.bet_id;
      }
      if (values.length > 0) {
        await queryRunner.query(
          `UPDATE bets AS b SET payload_hash = v.payload_hash
           FROM (VALUES ${values.join(",")}) AS v(payload_hash, bet_id)
           WHERE b.bet_id = v.bet_id`,
          parameters,
        );
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("UPDATE bets SET payload_hash = NULL");
    await queryRunner.query("DROP TABLE leaderboard_snapshots");
    await queryRunner.query("DROP INDEX idx_players_ranking");
    await queryRunner.query("ALTER TABLE players DROP COLUMN score_version");
    await queryRunner.query("DROP SEQUENCE tournament_score_version_seq");
  }
}

export { AddScoreRevisions as ReviewHardening };
