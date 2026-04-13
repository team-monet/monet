import { Trend } from "k6/metrics";
import { runMemoryStoreBurstScenario } from "./scenarios/memory-store-burst.js";
import { runMcpSessionChurnScenario } from "./scenarios/mcp-session-churn.js";
import { runMixedWorkloadScenario } from "./scenarios/mixed-workload.js";
import { runTier1SearchScenario } from "./scenarios/tier1-search.js";
import { runTier2FetchScenario } from "./scenarios/tier2-fetch.js";

function parseEnvInt(name, fallback) {
  const raw = __ENV[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

const seedPath = __ENV.LOAD_SEED_FILE || "/tmp/monet-load-seed.json";
const seed = JSON.parse(open(seedPath));

const baseUrl = __ENV.API_BASE_URL || "http://127.0.0.1:3001";
const requestTimeout = __ENV.LOAD_REQUEST_TIMEOUT || "10s";
const enableMcpChurn = __ENV.LOAD_ENABLE_MCP === "true";
const vus = parseEnvInt("LOAD_VUS", 10);
const duration = __ENV.LOAD_DURATION || "45s";

const scenarios = {
  tier1_search: {
    executor: "constant-vus",
    vus,
    duration,
    exec: "tier1Search",
  },
  tier2_fetch: {
    executor: "constant-vus",
    vus,
    duration,
    exec: "tier2Fetch",
  },
  memory_store_burst: {
    executor: "constant-vus",
    vus,
    duration,
    exec: "memoryStoreBurst",
  },
  mixed_workload: {
    executor: "constant-vus",
    vus,
    duration,
    exec: "mixedWorkload",
  },
};

if (enableMcpChurn) {
  scenarios.mcp_session_churn = {
    executor: "constant-vus",
    vus,
    duration,
    exec: "mcpSessionChurn",
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    tier1_search_latency: ["p(95)<500"],
    tier2_fetch_latency: ["p(95)<300"],
    memory_store_latency: ["p(95)<1000"],
    mixed_workload_latency: ["p(95)<600"],
  },
};

const tier1SearchLatency = new Trend("tier1_search_latency", true);
const tier2FetchLatency = new Trend("tier2_fetch_latency", true);
const memoryStoreLatency = new Trend("memory_store_latency", true);
const mixedWorkloadLatency = new Trend("mixed_workload_latency", true);
const mcpSessionChurnLatency = new Trend("mcp_session_churn_latency", true);

const sharedData = {
  baseUrl,
  requestTimeout,
  seed,
};

export function setup() {
  return sharedData;
}

export function tier1Search(data) {
  tier1SearchLatency.add(runTier1SearchScenario(data));
}

export function tier2Fetch(data) {
  tier2FetchLatency.add(runTier2FetchScenario(data));
}

export function memoryStoreBurst(data) {
  memoryStoreLatency.add(runMemoryStoreBurstScenario(data));
}

export function mixedWorkload(data) {
  mixedWorkloadLatency.add(runMixedWorkloadScenario(data));
}

export function mcpSessionChurn(data) {
  mcpSessionChurnLatency.add(runMcpSessionChurnScenario(data));
}
