import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LIMITS } from "../config/limits";
import { waitForDrain } from "../messaging/drain";
import { SignedInternalConsumer } from "../messaging/signed-internal.consumer";
import {
  LeaderboardProjection,
  ScoreProjection,
} from "./leaderboard.projection";

@Injectable()
export class LeaderboardConsumer
  extends SignedInternalConsumer
  implements OnModuleInit, OnModuleDestroy
{
  protected readonly queueSuffix = "leaderboard";
  private reconcileTimer?: NodeJS.Timeout;
  private reconciling = false;
  private reconcilePending: Promise<void> = Promise.resolve();

  constructor(
    config: ConfigService,
    private readonly projection: LeaderboardProjection,
  ) {
    super(config);
  }

  async onModuleInit(): Promise<void> {
    if (!(await this.projection.rebuild())) {
      await this.projection.waitUntilReady(
        this.config.getOrThrow<number>("leaderboard.readyWaitMs"),
      );
    }
    await this.start("player.score.changed", 100);
    this.reconcileTimer = setInterval(() => {
      if (!this.reconciling) {
        this.reconcilePending = this.reconcile();
      }
    }, this.config.getOrThrow<number>("leaderboard.reconcileIntervalMs"));
    this.reconcileTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.reconcileTimer);
    await this.stop();
    await waitForDrain(
      [this.reconcilePending],
      this.config.getOrThrow<number>("shutdown.workerDrainTimeoutMs"),
    );
  }

  protected async process(payload: unknown): Promise<void> {
    const score = payload as ScoreProjection;
    if (
      typeof score.playerId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(score.playerId) ||
      !Number.isInteger(score.points) ||
      score.points < 0 ||
      score.points > LIMITS.MAX_PLAYER_POINTS ||
      !Number.isFinite(Date.parse(score.pointsReachedAt)) ||
      (score.pointsReachedAtUs !== undefined &&
        (!/^\d+$/.test(score.pointsReachedAtUs) ||
          !Number.isSafeInteger(Number(score.pointsReachedAtUs)))) ||
      (score.scoreVersion !== undefined &&
        (!/^\d+$/.test(score.scoreVersion) ||
          !Number.isSafeInteger(Number(score.scoreVersion))))
    ) {
      throw new SyntaxError("Invalid score projection");
    }
    await this.projection.apply(score);
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling) {
      return;
    }
    this.reconciling = true;
    try {
      if (!(await this.projection.isReady())) {
        await this.projection.rebuild();
      } else {
        await this.projection.reconcile();
      }
    } catch (error) {
      this.logger.error("Leaderboard reconciliation failed", error);
    } finally {
      this.reconciling = false;
    }
  }
}
