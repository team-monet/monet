import http from "k6/http";
import { check, sleep } from "k6";
import { authHeaders, buildUrl, randomMemoryType } from "./utils.js";

export function runMemoryStoreBurstScenario(data) {
  const payload = JSON.stringify({
    content: `k6 store burst ${Date.now()}-${Math.random().toString(16).slice(2)}`,
    memoryType: randomMemoryType(),
    tags: ["load", "store-burst"],
    memoryScope: "group",
  });

  const res = http.post(buildUrl(data.baseUrl, "/api/memories"), payload, {
    headers: authHeaders(data.seed),
    timeout: data.requestTimeout,
  });

  check(res, {
    "store burst avoids 5xx": (r) => r.status < 500,
  });

  sleep(0.05);
  return res.timings.duration;
}
