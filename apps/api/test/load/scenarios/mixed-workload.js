import http from "k6/http";
import { check, sleep } from "k6";
import { authHeaders, buildUrl, pickRandom, randomMemoryType } from "./utils.js";

export function runMixedWorkloadScenario(data) {
  const action = Math.random();

  if (action < 0.6) {
    const token = pickRandom(["load", "group-1", "group-2", "tier"]);
    const res = http.get(
      buildUrl(data.baseUrl, `/api/memories?query=${encodeURIComponent(token)}&limit=10`),
      {
        headers: authHeaders(data.seed),
        timeout: data.requestTimeout,
      },
    );
    check(res, { "mixed search avoids 5xx": (r) => r.status < 500 });
    sleep(0.05);
    return res.timings.duration;
  }

  if (action < 0.8) {
    const payload = JSON.stringify({
      content: `k6 mixed store ${Date.now()}-${Math.random().toString(16).slice(2)}`,
      memoryType: randomMemoryType(),
      tags: ["load", "mixed"],
      memoryScope: "group",
    });
    const res = http.post(buildUrl(data.baseUrl, "/api/memories"), payload, {
      headers: authHeaders(data.seed),
      timeout: data.requestTimeout,
    });
    check(res, { "mixed store avoids 5xx": (r) => r.status < 500 });
    sleep(0.05);
    return res.timings.duration;
  }

  if (action < 0.9) {
    const memoryId = pickRandom(data.seed.sampleMemoryIds);
    const res = http.get(buildUrl(data.baseUrl, `/api/memories/${memoryId}`), {
      headers: authHeaders(data.seed),
      timeout: data.requestTimeout,
    });
    check(res, { "mixed fetch avoids 5xx": (r) => r.status < 500 });
    sleep(0.05);
    return res.timings.duration;
  }

  const res = http.get(buildUrl(data.baseUrl, "/api/agents/me"), {
    headers: authHeaders(data.seed),
    timeout: data.requestTimeout,
  });
  check(res, { "mixed metadata avoids 5xx": (r) => r.status < 500 });
  sleep(0.05);
  return res.timings.duration;
}
