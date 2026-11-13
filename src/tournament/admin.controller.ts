import { Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { RateLimitGuard } from "../security/rate-limit.guard";
import { RateLimitScope } from "../security/rate-limit-scope.decorator";
import { AdminGuard } from "./admin.guard";
import { FinalizationResult, TournamentService } from "./tournament.service";

@Controller("admin/tournament")
@RateLimitScope("admin")
@UseGuards(RateLimitGuard, AdminGuard)
export class AdminController {
  constructor(private readonly tournament: TournamentService) {}

  @Post("finalize")
  @HttpCode(200)
  finalize(): Promise<FinalizationResult> {
    return this.tournament.finalizeDue();
  }
}
