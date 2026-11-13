import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";

@Injectable()
export class TournamentStateInitializer implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const tournament = this.config.getOrThrow<{
      endsAt: string;
      settlementGraceMs: number;
      finalizeAfterMs: number;
    }>("tournament");
    const endsAt = Date.parse(tournament.endsAt);
    await this.dataSource.query(
      `INSERT INTO tournament_state (
        id, phase, ends_at, settlement_cutoff_at, finalize_at
      ) VALUES (1, 'ACTIVE', $1, $2, $3)
      ON CONFLICT (id) DO NOTHING`,
      [
        new Date(endsAt),
        new Date(endsAt + tournament.settlementGraceMs),
        new Date(endsAt + tournament.finalizeAfterMs),
      ],
    );
  }
}
