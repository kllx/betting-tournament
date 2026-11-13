import { Injectable } from "@nestjs/common";
import {
  Counter,
  collectDefaultMetrics,
  Histogram,
  Registry,
} from "@prometheus-io/client";

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly betEvents = new Counter({
    name: "bet_events_total",
    help: "Bet events by type and processing result",
    labelNames: ["event_type", "result"],
    registers: [this.registry],
  });
  private readonly betDuration = new Histogram({
    name: "bet_processing_duration_ms",
    help: "Bet processing duration in milliseconds",
    labelNames: ["event_type", "result"],
    buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
    registers: [this.registry],
  });
  private readonly fingerprintDuration = new Histogram({
    name: "fingerprint_duration_ms",
    help: "Fingerprint computation duration in milliseconds",
    labelNames: ["kind"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });
  private readonly outboxEvents = new Counter({
    name: "outbox_events_total",
    help: "Outbox publications by result",
    labelNames: ["event_type", "result"],
    registers: [this.registry],
  });
  private readonly payoutEvents = new Counter({
    name: "payout_events_total",
    help: "Payout confirmations by result",
    labelNames: ["result"],
    registers: [this.registry],
  });
  private readonly httpRequests = new Counter({
    name: "http_requests_total",
    help: "HTTP requests by method, route and status",
    labelNames: ["method", "route", "status"],
    registers: [this.registry],
  });
  private readonly httpDuration = new Histogram({
    name: "http_request_duration_ms",
    help: "HTTP request duration in milliseconds",
    labelNames: ["method", "route"],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
    registers: [this.registry],
  });
  private readonly rabbitmqDuration = new Histogram({
    name: "rabbitmq_publish_duration_ms",
    help: "RabbitMQ publish duration in milliseconds",
    labelNames: ["event_type", "result"],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
    registers: [this.registry],
  });
  private readonly riskSignals = new Counter({
    name: "bet_risk_signals_total",
    help: "Bet risk signals that require operational review",
    labelNames: ["kind"],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  betProcessed(eventType: string, result: string, durationMs: number): void {
    this.betEvents.inc({ event_type: eventType, result });
    this.betDuration.observe({ event_type: eventType, result }, durationMs);
  }

  fingerprintComputed(kind: string, durationMs: number): void {
    this.fingerprintDuration.observe({ kind }, durationMs);
  }

  outboxPublished(eventType: string, result: string): void {
    this.outboxEvents.inc({ event_type: eventType, result });
  }

  rabbitmqPublished(
    eventType: string,
    result: string,
    durationMs: number,
  ): void {
    this.rabbitmqDuration.observe(
      { event_type: eventType, result },
      durationMs,
    );
  }

  largeWin(): void {
    this.riskSignals.inc({ kind: "LARGE_WIN" });
  }

  scoreCapped(): void {
    this.riskSignals.inc({ kind: "SCORE_CAP" });
  }

  payoutConfirmed(result: string): void {
    this.payoutEvents.inc({ result });
  }

  httpHandled(
    method: string,
    route: string,
    status: number,
    durationMs: number,
  ): void {
    this.httpRequests.inc({ method, route, status });
    this.httpDuration.observe({ method, route }, durationMs);
  }
}
