import { Column, Entity, PrimaryColumn } from "typeorm";

export type BetStatus = "settled" | "rolled_back";

@Entity("bets")
export class BetEntity {
  @PrimaryColumn({ name: "bet_id", type: "varchar", length: 128 })
  betId: string;

  @Column({ name: "player_id", type: "varchar", length: 128 })
  playerId: string;

  @Column({ type: "varchar", length: 3 })
  currency: string;

  @Column({ type: "numeric" })
  stake: string;

  @Column({ name: "win_amount", type: "numeric" })
  winAmount: string;

  @Column({ name: "settled_at", type: "timestamptz" })
  settledAt: Date;

  @Column({ type: "integer" })
  points: number;

  @Column({ type: "varchar", length: 16 })
  status: BetStatus;

  @Column({ name: "payload_hash", type: "varchar", length: 64, nullable: true })
  payloadHash: string | null;
}
