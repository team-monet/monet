# Shared memory in action: support workflow wedge

This runbook provides a deterministic, operator-friendly demo for the support workflow scripts in this repository.

**Support is our wedge; shared memory is the platform.**

**This demo is support-shaped, but the pattern is universal for agent teams.**

---

## 1) What this demo proves

In under 10 minutes, you will show:

1. Agent A stores support context as shared memory
2. Agent B recalls that context in a separate session
3. Scope boundaries work (group-shared vs private)
4. Dashboard and audit logs expose memory visibility + actions
5. Support is just one concrete wedge of the broader shared-memory pattern

---

## 2) Prerequisites

- Local infra started:
  - `pnpm local:up`
- API running:
  - `pnpm local:dev:api`
- Dashboard running (for visibility/audit portions):
  - `pnpm local:dev:dashboard`
- Local env populated (`.env.local-dev`) with a valid `DATABASE_URL`

Optional but recommended:

- Run local Keycloak setup if this is a fresh environment:
  - `pnpm local:keycloak:setup`

---

## 3) Demo artifacts

- Seed: `scripts/demo/seed-support-workflow.ts`
- Reset: `scripts/demo/reset-support-workflow.ts`
- Smoke/preflight: `scripts/demo/smoke-support-workflow.ts`

Convenience commands:

- `pnpm demo:support:seed`
- `pnpm demo:support:smoke`
- `pnpm demo:support:reset`

State file produced by seed:

- `.local-dev/demo-support-workflow.json`

This file contains demo tenant/group/agent IDs and API keys for scripted/demo use.

---

## 4) Seed the demo data

From repo root:

```bash
pnpm demo:support:seed
```

Defaults used by the seed script:

- `API_BASE_URL=http://127.0.0.1:3301`
- `DEMO_TENANT_SLUG=demo-support-org`
- `DEMO_TENANT_NAME=Demo Support Org`

The seed creates/ensures:

- Tenant: `demo-support-org`
- Agent groups: `General`, `Support`
- Agents:
  - `support-l1-agent` (Support)
  - `support-l2-agent` (Support)
  - `billing-agent` (General)
- Deterministic memories (tags exactly):
  - `preference` (group)
  - `issue` (group)
  - `procedure` (group)
  - `fact` (private)
  - tags: `support,handoff,customer-42,login-failure,workaround`

Notes:

- The script is idempotent for demo entities and deterministic memories.
- On rerun, agent keys are rotated and state file is refreshed.

---

## 5) Preflight / smoke check

Run:

```bash
pnpm demo:support:smoke
```

Checks include:

- API readiness
- Agent key validity
- Shared-memory recall count for L2
- Private-memory denial for L2 (403)
- Memory audit entries visible to tenant admin

If smoke passes, demo is ready.

---

## 6) Live walkthrough script (≤10 min)

### 0:00–0:45 — Set context

Say:

- “Monet is the shared memory layer for multi-agent teams.”
- “Support is our wedge; shared memory is the platform.”
- “This demo is support-shaped, but the pattern is universal for agent teams.”

### 0:45–2:30 — Agent A stores memory

Use `support-l1-agent` API key from `.local-dev/demo-support-workflow.json`.

Show (or re-run) memory creation via API examples:

```bash
API_BASE_URL=http://127.0.0.1:3301
TENANT_SLUG="demo-support-org"
L1_KEY="<support-l1-agent-api-key>"

curl -sS -X POST "$API_BASE_URL/api/tenants/$TENANT_SLUG/memories" \
  -H "Authorization: Bearer $L1_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content":"[demo-support] customer-42 contact preference: email only between 09:00-17:00 America/Los_Angeles; avoid callback outside window.",
    "memoryType":"preference",
    "memoryScope":"group",
    "tags":["support","handoff","customer-42","login-failure","workaround"]
  }'
```

Repeat similarly for issue/procedure if you want to show writes live.

### 2:30–4:00 — Agent B retrieves across session

Use `support-l2-agent` key in a fresh terminal/session:

```bash
L2_KEY="<support-l2-agent-api-key>"

curl -sS "$API_BASE_URL/api/tenants/$TENANT_SLUG/memories?query=%5Bdemo-support%5D&limit=20" \
  -H "Authorization: Bearer $L2_KEY"
```

Call out: no copied context, only shared memory recall across sessions.

### 4:00–5:30 — Scope boundary proof

Use private memory ID from the state file:

```bash
PRIVATE_ID="<state.memories.privateFact.id>"

curl -i -sS "$API_BASE_URL/api/tenants/$TENANT_SLUG/memories/$PRIVATE_ID" \
  -H "Authorization: Bearer $L2_KEY"
```

Expected: `403` (private memory inaccessible to non-author agent).

### 5:30–7:00 — Dashboard visibility

In dashboard, open the demo tenant and show:

- Memory list entries for `[demo-support]`
- Tag search using `support` / `customer-42`
- Memory detail view with scope/type metadata

### 7:00–8:30 — Audit trail

Show audit page filtered around memory actions (`memory.create`, `memory.search`, `memory.get`).

Optional API proof:

```bash
ADMIN_KEY="<tenant-admin-api-key>"

curl -sS "$API_BASE_URL/api/tenants/$TENANT_SLUG/audit?limit=100" \
  -H "Authorization: Bearer $ADMIN_KEY"
```

### 8:30–9:30 — Broader framing close

Say:

- “We used support for concreteness.”
- “This same shared-memory pattern applies to any multi-agent workflow: sales, ops, engineering, reliability, etc.”

---

## 7) Reset and rerun

To cleanly reset demo data:

```bash
pnpm demo:support:reset
```

Then reseed and smoke-check:

```bash
pnpm demo:support:seed
pnpm demo:support:smoke
```

Run this sequence before each rehearsal to avoid mid-demo surprises.
