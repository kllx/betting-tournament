export const ROUTING_KEYS = {
  BET_SETTLED: "bet.settled",
  BET_ROLLBACK: "bet.rollback",
  PAYOUT_REQUESTED: "payout.requested",
  PLAYER_SCORE_CHANGED: "player.score.changed",
} as const;

export const EVENT_DOMAINS = {
  BET: "bet-event-v1",
  INTERNAL: "internal-event-v1",
} as const;

export const DEAD_LETTER_ROUTING_KEY = "dead-letter";
