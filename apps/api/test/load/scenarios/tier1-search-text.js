import http from "k6/http";
import { check, sleep } from "k6";
import { authHeaders, buildTenantApiUrl, pickRandom } from "./utils.js";

export function runTier1SearchTextScenario(data) {
  const queryToken = pickRandom(["load", "validation", "tier"]);
  const url = buildTenantApiUrl(
    data.baseUrl,
    data.seed,
    `/memories?query=${encodeURIComponent(queryToken)}&limit=20`,
  );

  const res = http.get(url, {
    // Intentionally no embedding-related headers/params; text query only.
    headers: authHeaders(data.seed),
    timeout: data.requestTimeout,
  });

  check(res, {
    "tier1 text search status is 200": (r) => r.status === 200,
    "tier1 text search has items array": (r) => {
      const body = r.json();
      return Array.isArray(body.items);
    },
  });

  sleep(0.1);
  return res.timings.duration;
}
