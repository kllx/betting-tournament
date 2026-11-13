import { createServer, get, Server } from "node:http";
import { AddressInfo } from "node:net";
import { HttpTerminator } from "./http-terminator";

describe("HttpTerminator", () => {
  let server: Server;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes the server and destroys connections after the grace period", async () => {
    server = createServer((_request, response) => {
      setTimeout(() => response.end("ok"), 1000);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const terminator = new HttpTerminator(server, 50, 10);
    const request = get(`http://127.0.0.1:${port}/`, () => undefined);
    request.on("error", () => undefined);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await terminator.terminate();

    expect(terminator.isTerminating).toBe(true);
    expect(server.listening).toBe(false);
  });
});
