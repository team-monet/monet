export type LogLevel = "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  latencyMs?: number;
  tenantId?: string;
  agentId?: string;
  [key: string]: unknown;
}

type StructuredLogInput = Omit<StructuredLogEntry, "timestamp"> & {
  timestamp?: string;
};

export function formatLogEntry(input: StructuredLogInput): string {
  const { timestamp, ...rest } = input;
  return JSON.stringify({
    timestamp: timestamp ?? new Date().toISOString(),
    ...rest,
  });
}

export function writeStructuredLog(input: StructuredLogInput): void {
  const level = input.level as LogLevel;

  if (!shouldLogLevel(level)) {
    return;
  }

  const rendered = formatLogEntry(input);
  switch (level) {
    case "error":
      console.error(rendered);
      return;
    case "warn":
      console.warn(rendered);
      return;
    default:
      console.log(rendered);
  }
}

export function logRequest(input: {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  tenantId?: string;
  agentId?: string;
  message?: string;
}): void {
  if (!isRequestLoggingEnabled()) {
    return;
  }

  writeStructuredLog({
    level: "info",
    message: input.message ?? "request",
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    statusCode: input.statusCode,
    latencyMs: Number(input.latencyMs.toFixed(2)),
    tenantId: input.tenantId,
    agentId: input.agentId,
  });
}

function isRequestLoggingEnabled(): boolean {
  if (process.env.LOG_REQUESTS === "false") {
    return false;
  }

  if (process.env.NODE_ENV === "test" && process.env.FORCE_REQUEST_LOGS !== "true") {
    return false;
  }

  return true;
}

function shouldLogLevel(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getConfiguredLogLevel()];
}

function getConfiguredLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  switch (raw) {
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return "info";
  }
}
