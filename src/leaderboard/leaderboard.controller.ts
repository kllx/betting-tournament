import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  UseGuards,
} from "@nestjs/common";
import { HTTP_HEADERS } from "../contracts/http";
import { RateLimitGuard } from "../security/rate-limit.guard";
import { RateLimitScope } from "../security/rate-limit-scope.decorator";
import { LeaderboardResponse, LeaderboardService } from "./leaderboard.service";

@Controller("leaderboard")
@RateLimitScope("leaderboard")
@UseGuards(RateLimitGuard)
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  getLeaderboard(
    @Headers(HTTP_HEADERS.PLAYER_ID) playerId?: string,
  ): Promise<LeaderboardResponse> {
    if (!playerId || playerId.length > 128) {
      throw new BadRequestException(
        "X-Player-Id must be a non-empty string of at most 128 characters",
      );
    }

    return this.leaderboard.getLeaderboard(playerId);
  }
}
