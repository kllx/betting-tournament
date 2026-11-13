import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { LeaderboardPhaseService } from "../src/leaderboard/leaderboard-phase.service";
import { LeaderboardProjection } from "../src/leaderboard/leaderboard.projection";
import { LeaderboardService } from "../src/leaderboard/leaderboard.service";
import { TournamentService } from "../src/tournament/tournament.service";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Cached tournament phase", () => {
  let dataSource: DataSource;
  let redis: Redis;
  let phase: LeaderboardPhaseService;
  let service: LeaderboardService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    redis = new Redis("redis://localhost:56379/11");
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
    await redis.flushdb();
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('winner', 100)",
    );
    phase = new LeaderboardPhaseService(
      redis,
      dataSource,
      new ConfigService({ leaderboard: { activePhaseTtlMs: 1000 } }),
    );
    service = new LeaderboardService(dataSource, redis, undefined, phase);
    await new LeaderboardProjection(redis, dataSource).rebuild();
  });

  afterAll(async () => {
    await redis.quit();
    await dataSource.destroy();
  });

  it("serves repeated active reads without querying PostgreSQL for phase", async () => {
    await service.getLeaderboard("winner");
    const query = jest.spyOn(dataSource, "query");

    await expect(service.getLeaderboard("winner")).resolves.toEqual({
      top: [{ rank: 1, playerId: "winner", points: 100 }],
      player: { rank: 1, playerId: "winner", points: 100 },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("switches to the final snapshot without allowing a stale phase downgrade", async () => {
    await service.getLeaderboard("winner");
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );
    await new TournamentService(dataSource, [100]).finalizeDue();
    const events = await dataSource.query(
      "SELECT payload FROM outbox WHERE event_type = 'tournament.phase.changed'",
    );

    await phase.apply(events[0].payload);
    await phase.apply({ phase: "ACTIVE", version: "0" });

    await expect(service.getLeaderboard("winner")).resolves.toEqual({
      top: [{ rank: 1, playerId: "winner", points: 100 }],
      player: { rank: 1, playerId: "winner", points: 100 },
    });
  });

  it("recovers the final phase when the phase event is permanently lost", async () => {
    phase = new LeaderboardPhaseService(
      redis,
      dataSource,
      new ConfigService({ leaderboard: { activePhaseTtlMs: 50 } }),
    );
    service = new LeaderboardService(dataSource, redis, undefined, phase);
    await service.getLeaderboard("winner");
    await dataSource.query(
      "UPDATE tournament_state SET finalize_at = now() - interval '1 second'",
    );
    await new TournamentService(dataSource, [100]).finalizeDue();
    await dataSource.query(
      "UPDATE outbox SET status = 'FAILED' WHERE event_type = 'tournament.phase.changed'",
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(service.getLeaderboard("winner")).resolves.toEqual({
      top: [{ rank: 1, playerId: "winner", points: 100 }],
      player: { rank: 1, playerId: "winner", points: 100 },
    });
  });
});
