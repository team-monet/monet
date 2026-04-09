# Observability Guide

This guide describes the current Monet observability surface for M4.

Today, Monet’s operator-facing signals are:

- structured JSON request logs for HTTP API and MCP
- readiness and liveness endpoints
- tenant-admin usage/benefit/health metrics from `/api/tenants/:tenantSlug/metrics`
- startup validation output and runtime warnings on stdout/stderr

Monet does not currently ship a Prometheus exporter or OpenTelemetry pipeline.
The recommended approach is to ship container logs to your existing platform and
derive alerts from logs, health probes, and the tenant-admin metrics view.

## Structured Logs

Structured request logs are emitted for:

- HTTP API requests with message `http_request`
- MCP requests with message `mcp_request`

Each request log includes:

- `timestamp`
- `level`
- `message`
- `requestId`
- `method`
- `path`
- `statusCode`
- `latencyMs`
- `tenantId` when available
- `agentId` when available

The request ID is also returned to callers in the `X-Request-Id` header. Use it
as the primary join key when investigating incidents.

Example API request log:

```json
{
  "timestamp": "2026-03-22T05:00:00.000Z",
  "level": "info",
  "message": "http_request",
  "requestId": "8f0d2e54-64de-4bf1-a8f9-1479f91067c9",
  "method": "GET",
  "path": "/api/tenants/acme/agents/me",
  "statusCode": 200,
  "latencyMs": 12.41,
  "tenantId": "dca9d2f4-7db6-47e0-98d0-68e5516b74cb",
  "agentId": "ca668e4c-b03d-4c78-b414-e8e58d866097"
}
```

## Log Controls

Current logging env vars:

- `LOG_LEVEL`
  - supported values: `info`, `warn`, `error`
  - default: `info`
  - gates structured log emission, including request logs
- `LOG_REQUESTS`
  - default: `true`
  - set `LOG_REQUESTS=false` to suppress structured request logs

Recommended production default:

- `LOG_LEVEL=info`
- leave `LOG_REQUESTS` enabled

If you need to reduce noise temporarily:

- use `LOG_LEVEL=warn` to suppress info-level structured request logs
- use `LOG_REQUESTS=false` only for short-lived debugging or cost-control situations

## Health Signals

Use these endpoints:

- `GET /health`
- `GET /health/live`
- `GET /healthz`
- `GET /health/ready`

Operational meaning:

- `/health/live` and `/healthz` confirm the process is alive
- `/health/ready` confirms Monet can serve traffic

`/health/ready` reports component status for:

- database connectivity
- platform migrations
- MCP session subsystem
- enrichment configuration
- audit retention health

Treat `/health/ready != 200` as a paging signal for the service, especially when
the failure is in database connectivity, migrations, or MCP availability.

## Tenant Metrics

Tenant admins can inspect runtime metrics through
`GET /api/tenants/:tenantSlug/metrics`.

The response has three sections:

- `usage`
  - 14-day `readWriteFrequency`
  - `activeAgents`
  - `enrichmentThroughput`
  - `searchHitRate`
  - `semanticSearchPct`
- `benefit`
  - `usefulnessDistribution`
  - `memoryReuseRate`
  - `tagDiversityByGroup`
  - `enrichmentQuality`
  - `crossAgentSharing`
- `health`
  - `memoryLifecycle`
  - `quotaUtilization`

This endpoint is useful for tenant-level dashboards and support investigations,
but it is not a replacement for platform-wide infrastructure monitoring.

## What To Monitor

At the platform level, monitor these first:

- HTTP and MCP request rate
- p95 and p99 request latency
- 5xx response rate
- 429 rate-limit response rate
- readiness failures
- startup validation failures
- enrichment failure warnings
- audit retention and TTL purge errors

At the tenant level, monitor these next:

- memory search hit rate
- enrichment throughput and failed count
- semantic search percentage
- quota utilization per group
- outdated and expired memory percentages
- cross-agent sharing volume

## Recommended Alerts

Start with these thresholds:

- API readiness failing for 2 consecutive minutes
- 5xx rate above 2% for 5 minutes
- p95 request latency above 1000ms for 10 minutes
- sustained 429s above 5% for 10 minutes
- startup validation failure on deploy
- enrichment failed count increasing continuously for 15 minutes
- any audit retention or TTL purge error log in production
- quota utilization above 90% for any business-critical group

These are starting points, not hard standards. Tune them after you observe real
traffic and tenant behavior.

## Integration Guidance

### Datadog

Recommended approach:

- collect Docker stdout/stderr from the Monet containers
- parse JSON logs from API and MCP request streams
- promote `requestId`, `tenantId`, `agentId`, `path`, and `statusCode` to facets

Suggested dashboards:

- request volume by `message`, `path`, and `statusCode`
- latency percentiles over time
- 5xx and 429 counts
- readiness failure count
- enrichment warning/error count

### Grafana

Recommended approach:

- ship container logs to Loki or another log backend
- parse JSON request logs
- build dashboards from log-derived metrics plus uptime checks on `/health/ready`

Suggested panels:

- request count by route
- p95 latency by route
- error count by route
- readiness status
- warning/error log volume over time

### CloudWatch

Recommended approach:

- ship container stdout/stderr into CloudWatch Logs
- create metric filters on structured request logs and warning/error lines
- alarm on readiness failures and rising 5xx volume

Suggested metric filters:

- `$.message = "http_request"`
- `$.message = "mcp_request"`
- `$.statusCode >= 500`
- `$.statusCode = 429`

## Investigation Workflow

When debugging a request or incident:

1. Start with the `requestId` from the client response header.
2. Pull the matching API or MCP request log.
3. Check readiness and recent startup logs.
4. Check for nearby warning/error lines about DB, enrichment, audit retention, or MCP transport.
5. If the issue is tenant-specific, inspect
   `/api/tenants/:tenantSlug/metrics` for that tenant.

## Known Limits

Current observability gaps:

- no built-in Prometheus scrape endpoint
- no native OpenTelemetry export
- non-request application logs are not yet uniformly structured JSON
- `/api/tenants/:tenantSlug/metrics` is tenant-admin scoped, not a
  platform-wide operator endpoint

For M4, the recommended operating model is still sufficient: structured request
logs, readiness, and targeted tenant metrics give a workable production signal
set while the deployment/docs milestone is completed.
