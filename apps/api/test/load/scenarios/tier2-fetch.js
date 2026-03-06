import http from "k6/http";
import { check, sleep } from "k6";
import { authHeaders, buildUrl, pickRandom } from "./utils.js";

export function runTier2FetchScenario(data) {
  const memoryId = pickRandom(data.seed.sampleMemoryIds);
  const url = buildUrl(data.baseUrl, `/api/memories/${memoryId}`);

  const res = http.get(url, {
    headers: authHeaders(data.seed),
    timeout: data.requestTimeout,
  });

  check(res, {
    "tier2 fetch status is 200": (r) => r.status === 200,
    "tier2 fetch returns entry": (r) => {
      const body = r.json();
      return body && body.entry && typeof body.entry.id === "string";
    },
  });

  sleep(0.05);
  return res.timings.duration;
}
