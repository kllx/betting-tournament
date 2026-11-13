import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("players")
export class PlayerEntity {
  @PrimaryColumn({ name: "player_id", type: "varchar", length: 128 })
  playerId: string;

  @Column({ type: "integer", default: 0 })
  points: number;

  @Column({ name: "points_reached_at", type: "timestamptz" })
  pointsReachedAt: Date;

  @Column({ name: "score_version", type: "bigint" })
  scoreVersion: string;
}
