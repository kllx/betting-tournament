import { performance } from "node:perf_hooks";
import { Injectable, Optional } from "@nestjs/common";
import { BetEvent } from "../bets/bet-event";
import { betFingerprint, eventFingerprint } from "../security/fingerprint";
import { MetricsService } from "./metrics.service";

@Injectable()
export class FingerprintService {
  constructor(@Optional() readonly metrics?: MetricsService) {}

  async trackBet<T extends { status: string }>(
    eventType: string,
    operation: Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await operation;
      this.metrics?.betProcessed(
        eventType,
        result.status,
        performance.now() - started,
      );
      return result;
    } catch (error) {
      this.metrics?.betProcessed(
        eventType,
        "error",
        performance.now() - started,
      );
      throw error;
    }
  }

  event(type: string, rawPayload: string): string {
    const started = performance.now();
    try {
      return eventFingerprint(type, rawPayload);
    } finally {
      this.metrics?.fingerprintComputed("event", performance.now() - started);
    }
  }

  bet(event: BetEvent): string {
    const started = performance.now();
    try {
      return betFingerprint(event);
    } finally {
      this.metrics?.fingerprintComputed("bet", performance.now() - started);
    }
  }
}
