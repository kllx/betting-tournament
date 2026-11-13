import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";
import { DataSource } from "typeorm";
import { GracefulShutdownService } from "./graceful-shutdown.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: Redis,
    private readonly shutdown: GracefulShutdownService,
  ) {}

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: string }> {
    if (this.shutdown.isTerminating) {
      throw new ServiceUnavailableException("Application is terminating");
    }
    try {
      await this.dataSource.query("SELECT 1");
      await this.redis.ping();
      return { status: "ok" };
    } catch {
      throw new ServiceUnavailableException("Dependencies are not ready");
    }
  }
}
