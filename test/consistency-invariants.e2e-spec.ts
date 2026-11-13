import { DataSource } from "typeorm";
import { BetEvent } from "../src/bets/bet-event";
import { BetProcessingService } from "../src/bets/bet-processing.service";
import { LIMITS } from "../src/config/limits";
import { PointsCalculator } from "../src/scoring/points-calculator";
import { createTestDataSource, resetTestDataSource } from "./test-database";

describe("Ledger consistency invariants", () => {
  let dataSource: DataSource;
  let service: BetProcessingService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    service = new BetProcessingService(
      dataSource,
      new PointsCalculator({ USD: 1 }),
    );
  });

  beforeEach(async () => {
    await resetTestDataSource(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("matches a ledger model under randomized concurrent deliveries", async () => {
    let seed = 0x12345678;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const expected = new Map<
      string,
      { awarded: number; balance: number; rolledBack: boolean }
    >();
    const deliveries: Array<Promise<unknown>> = [];

    for (let index = 0; index < 24; index += 1) {
      const event: BetEvent = {
        betId: `model-bet-${index}`,
        playerId: `model-player-${index}`,
        currency: "USD",
        stake: 1,
        winAmount: index + 1,
        settledAt: "2026-11-12T10:00:00.000Z",
      };
      const rolledBack = random() > 0.4;
      const awarded = index + 1;
      expected.set(event.betId, {
        awarded,
        balance: rolledBack ? 0 : awarded,
        rolledBack,
      });
      deliveries.push(service.process("bet.settled", event, `settle-${index}`));
      deliveries.push(service.process("bet.settled", event, `settle-${index}`));
      deliveries.push(
        service.process("bet.settled", event, `settle-copy-${index}`),
      );
      if (rolledBack) {
        deliveries.push(
          service.process("bet.rollback", event, `rollback-${index}`),
        );
        deliveries.push(
          service.process("bet.rollback", event, `rollback-${index}`),
        );
      }
    }
    const results = await Promise.allSettled(deliveries);

    expect(results.filter((result) => result.status === "rejected")).toEqual(
      [],
    );
    const bets = await dataSource.query(
      "SELECT bet_id, points, status FROM bets ORDER BY bet_id",
    );
    expect(bets).toHaveLength(expected.size);
    for (const bet of bets) {
      const model = expected.get(bet.bet_id);
      if (model?.rolledBack) {
        expect([0, model.awarded]).toContain(bet.points);
        expect(bet.status).toBe("rolled_back");
      } else {
        expect(bet.points).toBe(model?.awarded);
        expect(bet.status).toBe("settled");
      }
    }
    const totals = await dataSource.query(`
      SELECT COALESCE(SUM(points), 0)::int AS points FROM players
    `);
    const expectedTotal = [...expected.values()].reduce(
      (sum, entry) => sum + entry.balance,
      0,
    );
    expect(totals).toEqual([{ points: expectedTotal }]);
    const negative = await dataSource.query(
      "SELECT count(*)::int AS count FROM players WHERE points < 0",
    );
    expect(negative).toEqual([{ count: 0 }]);
  }, 30000);

  it("rolls back the bet and inbox when the score outbox insert fails", async () => {
    await dataSource.query(`
      INSERT INTO outbox (event_id, event_type, payload)
      VALUES ('score:collision', 'player.score.changed', '{}')
    `);
    const event: BetEvent = {
      betId: "collision-bet",
      playerId: "collision-player",
      currency: "USD",
      stake: 1,
      winAmount: 10,
      settledAt: "2026-11-12T10:00:00.000Z",
    };

    await expect(
      service.process("bet.settled", event, "collision"),
    ).rejects.toThrow();

    const counts = await dataSource.query(`
      SELECT
        (SELECT count(*)::int FROM bets) AS bets,
        (SELECT count(*)::int FROM players) AS players,
        (SELECT count(*)::int FROM bet_events) AS events,
        (SELECT count(*)::int FROM bet_event_ids) AS ids
    `);
    expect(counts).toEqual([{ bets: 0, players: 0, events: 0, ids: 0 }]);
  });

  it("caps awarded points and rolls back only the awarded remainder", async () => {
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('limited', $1)",
      [LIMITS.MAX_PLAYER_POINTS - 5],
    );
    const event: BetEvent = {
      betId: "limit-bet",
      playerId: "limited",
      currency: "USD",
      stake: 1,
      winAmount: 10,
      settledAt: "2026-11-12T10:00:00.000Z",
    };

    const second = { ...event, betId: "limit-bet-2", winAmount: 5 };
    await service.process("bet.settled", event);
    await service.process("bet.settled", second);
    await service.process("bet.rollback", second);
    await service.process("bet.rollback", event);

    const player = await dataSource.query(
      "SELECT points FROM players WHERE player_id = 'limited'",
    );
    expect(player).toEqual([{ points: LIMITS.MAX_PLAYER_POINTS - 5 }]);
    const bets = await dataSource.query(
      "SELECT bet_id, points, status FROM bets ORDER BY bet_id",
    );
    expect(bets).toEqual([
      { bet_id: "limit-bet", points: 5, status: "rolled_back" },
      { bet_id: "limit-bet-2", points: 0, status: "rolled_back" },
    ]);
  });

  it("never awards more than the remaining points during concurrent settlements", async () => {
    await dataSource.query(
      "INSERT INTO players (player_id, points) VALUES ('limited', $1)",
      [LIMITS.MAX_PLAYER_POINTS - 5],
    );

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.process("bet.settled", {
          betId: `cap-race-${index}`,
          playerId: "limited",
          currency: "USD",
          stake: 1,
          winAmount: 1,
          settledAt: "2026-11-12T10:00:00.000Z",
        }),
      ),
    );

    const player = await dataSource.query(
      "SELECT points FROM players WHERE player_id = 'limited'",
    );
    expect(player).toEqual([{ points: LIMITS.MAX_PLAYER_POINTS }]);
    const awarded = await dataSource.query(
      "SELECT COALESCE(SUM(points), 0)::int AS points FROM bets",
    );
    expect(awarded).toEqual([{ points: 5 }]);
  });
});
