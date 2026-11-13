import { ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { GracefulShutdownService } from "./graceful-shutdown.service";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  const shutdownState = { isTerminating: false };
  let dataSource: DataSource;
  let redis: Redis;
  let controller: HealthController;
  let query: jest.Mock;
  let ping: jest.Mock;

  beforeEach(() => {
    shutdownState.isTerminating = false;
    query = jest.fn().mockResolvedValue([]);
    ping = jest.fn().mockResolvedValue("PONG");
    dataSource = { query } as unknown as DataSource;
    redis = { ping } as unknown as Redis;
    controller = new HealthController(
      dataSource,
      redis,
      shutdownState as GracefulShutdownService,
    );
  });

  it("is live without checking external dependencies", () => {
    expect(controller.live()).toEqual({ status: "ok" });
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it("is ready only when PostgreSQL and Redis respond", async () => {
    await expect(controller.ready()).resolves.toEqual({ status: "ok" });
  });

  it("fails readiness when PostgreSQL is unavailable", async () => {
    query.mockRejectedValue(new Error("database down"));

    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("fails readiness when Redis is unavailable", async () => {
    ping.mockRejectedValue(new Error("redis down"));

    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("fails readiness during shutdown without new dependency calls", async () => {
    shutdownState.isTerminating = true;

    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });
});
