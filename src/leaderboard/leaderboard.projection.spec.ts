import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardProjection } from "./leaderboard.projection";

describe("LeaderboardProjection pipeline", () => {
  it("rejects when a Redis command in the batch fails", async () => {
    const redis = {
      pipeline: () => ({
        eval: () => undefined,
        exec: () => Promise.resolve([[new Error("redis command failed"), 1]]),
      }),
    } as unknown as Redis;
    const projection = new LeaderboardProjection(redis, {
      query: () => Promise.resolve([]),
    } as unknown as DataSource);

    await expect(
      (projection as any).applyBatch(
        [
          {
            player_id: "player-1",
            points: 1,
            points_reached_at: new Date(),
            score_version: "1",
          },
        ],
        {
          players: "players",
          members: "members",
          versions: "versions",
        },
      ),
    ).rejects.toThrow("redis command failed");
  });
});
