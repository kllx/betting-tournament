import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { LIMITS } from "../config/limits";

const sourceScriptPath = join(__dirname, "lua", "release-lock.lua");
const bundledScriptPath = join(
  __dirname,
  "..",
  "..",
  "leaderboard",
  "lua",
  "release-lock.lua",
);
const releaseLockScript = readFileSync(
  existsSync(sourceScriptPath) ? sourceScriptPath : bundledScriptPath,
  "utf8",
);
const renewLockScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

export class ReconciliationLock {
  static readonly key = "tournament:leaderboard:reconcile-lock";
  private token?: string;
  private renewal?: NodeJS.Timeout;
  private lost = false;

  constructor(
    private readonly redis: Redis,
    private readonly ttlMs: number = LIMITS.RECONCILE_LOCK_TTL_MS,
    private readonly renewIntervalMs: number = LIMITS.RECONCILE_LOCK_RENEW_INTERVAL_MS,
  ) {}

  get ownerToken(): string {
    if (!this.token) {
      throw new Error("Reconciliation lock is not acquired");
    }
    return this.token;
  }

  acquire = async (): Promise<boolean> => {
    const token = randomUUID();
    const acquired = await this.redis.set(
      ReconciliationLock.key,
      token,
      "PX",
      this.ttlMs,
      "NX",
    );
    if (acquired !== "OK") {
      return false;
    }

    this.token = token;
    this.renewal = setInterval(() => {
      void this.renew();
    }, this.renewIntervalMs);
    this.renewal.unref();
    return true;
  };

  assertOwnership = async (): Promise<void> => {
    if (
      this.lost ||
      !this.token ||
      (await this.redis.get(ReconciliationLock.key)) !== this.token
    ) {
      this.markLost();
      throw new Error("Reconciliation lock lost");
    }
  };

  release = async (): Promise<void> => {
    clearInterval(this.renewal);
    if (this.token) {
      await this.redis.eval(
        releaseLockScript,
        1,
        ReconciliationLock.key,
        this.token,
      );
      this.token = undefined;
    }
  };

  private renew = async (): Promise<void> => {
    if (!this.token || this.lost) {
      return;
    }
    try {
      const renewed = await this.redis.eval(
        renewLockScript,
        1,
        ReconciliationLock.key,
        this.token,
        this.ttlMs,
      );
      if (renewed !== 1) {
        this.markLost();
      }
    } catch {
      this.markLost();
    }
  };

  private markLost(): void {
    this.lost = true;
    clearInterval(this.renewal);
  }
}
