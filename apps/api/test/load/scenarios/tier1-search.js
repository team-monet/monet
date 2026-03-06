import http from "k6/http";
import { check, sleep } from "k6";
import { authHeaders, buildUrl, pickRandom } from "./utils.js";

export function runTier1SearchScenario(data) {
  const queryToken = pickRandom(["load", "group-1", "group-2", "validation", "tier"]);
  const url = buildUrl(
    data.baseUrl,
    `/api/memories?query=${encodeURIComponent(queryToken)}&limit=20`,
  );

  const res = http.get(url, {
    headers: authHeaders(data.seed),
    timeout: data.requestTimeout,
  });

  check(res, {
    "tier1 search status is 200": (r) => r.status === 200,
    "tier1 search has items array": (r) => {
      const body = r.json();
      return Array.isArray(body.items);
    },
  });

  sleep(0.1);
  return res.timings.duration;
}
