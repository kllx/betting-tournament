import { setInterval as setIntervalP } from "node:timers/promises";
import { Socket } from "node:net";
import { Server } from "node:http";

export class HttpTerminator {
  private readonly connections = new Set<Socket>();
  private terminating = false;

  constructor(
    private readonly server: Server,
    private readonly gracefulPeriodMs: number,
    private readonly checkIntervalMs: number,
  ) {
    this.server.on("connection", (connection) => {
      this.connections.add(connection);
      connection.once("close", () => this.connections.delete(connection));
    });
  }

  get isTerminating(): boolean {
    return this.terminating;
  }

  async terminate(): Promise<void> {
    if (this.terminating) {
      return;
    }
    this.terminating = true;
    this.server.on("request", (_request, response) => {
      if (!response.headersSent) {
        response.setHeader("connection", "close");
      }
    });

    try {
      await this.waitForConnections();
    } finally {
      for (const connection of this.connections) {
        connection.destroy();
      }
      this.connections.clear();
      await this.closeServer();
    }
  }

  private async waitForConnections(): Promise<void> {
    for await (const startTime of setIntervalP(
      this.checkIntervalMs,
      Date.now(),
    )) {
      if (
        this.connections.size === 0 ||
        Date.now() - startTime >= this.gracefulPeriodMs
      ) {
        return;
      }
    }
  }

  private async closeServer(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
