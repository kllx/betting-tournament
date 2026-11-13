import { check } from "k6";
import http from "k6/http";

export const options = {
  scenarios: {
    leaderboard: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 5000),
      timeUnit: "1s",
      duration: __ENV.DURATION || "10s",
      preAllocatedVUs: 500,
      maxVUs: Number(__ENV.MAX_VUS || 10000),
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    dropped_iterations: ["count==0"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(99)<1000"],
  },
};

export default function () {
  const playerId = `player-${((__VU - 1) + __ITER * 10000) % 1000000}`;
  const response = http.get(`${__ENV.BASE_URL}/leaderboard`, {
    headers: { "X-Player-Id": playerId },
  });
  check(response, {
    "status is 200": (value) => value.status === 200,
    "player exists": (value) => value.json("player") !== null,
  });
}

export function handleSummary(data) {
  return {
    "/scripts/results/leaderboard-summary.json": JSON.stringify(data, null, 2),
  };
}
