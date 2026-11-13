import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SignedInternalConsumer } from "../messaging/signed-internal.consumer";
import {
  LeaderboardPhaseService,
  TournamentPhaseProjection,
} from "./leaderboard-phase.service";

@Injectable()
export class TournamentPhaseConsumer
  extends SignedInternalConsumer
  implements OnModuleInit, OnModuleDestroy
{
  protected readonly queueSuffix = "phase";

  constructor(
    config: ConfigService,
    private readonly phase: LeaderboardPhaseService,
  ) {
    super(config);
  }

  async onModuleInit(): Promise<void> {
    await this.start("tournament.phase.changed", 20);
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  protected async process(payload: unknown): Promise<void> {
    await this.phase.apply(payload as TournamentPhaseProjection);
  }
}
