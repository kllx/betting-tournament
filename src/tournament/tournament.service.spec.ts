import { DataSource, EntityManager } from "typeorm";
import { TournamentService } from "./tournament.service";

describe("TournamentService due check", () => {
  it("does not lock tournament state before the finalization deadline", async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ phase: "ACTIVE", due: false }]);
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        (operation: (entityManager: EntityManager) => Promise<unknown>) =>
          operation(manager),
      ),
    } as unknown as DataSource;
    const service = new TournamentService(dataSource, [100]);

    await expect(service.finalizeDue()).resolves.toEqual({
      finalized: false,
      phase: "ACTIVE",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain("FOR UPDATE");
  });
});
