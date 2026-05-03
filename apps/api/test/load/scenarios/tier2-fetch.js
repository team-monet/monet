import http from "k6/http";
import { check, sleep } from "k6";
import {
  authHeadersForGroup,
  buildTenantApiUrl,
  pickRandom,
  pickRandomGroupSample,
} from "./utils.js";

export function runTier2FetchScenario(data) {
  const groupSample = pickRandomGroupSample(data.seed);
  const memoryId =
    pickRandom(groupSample && groupSample.memoryIds) || pickRandom(data.seed.sampleMemoryIds);
  const url = buildTenantApiUrl(data.baseUrl, data.seed, `/memories/${memoryId}`);

  const res = http.get(url, {
    headers: authHeadersForGroup(data.seed, groupSample && groupSample.groupId),
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
