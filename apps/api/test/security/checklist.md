# Threat Model Verification Checklist (M8)

## Scope

This checklist validates Phase 1 controls from the Monet threat model against implemented tests and runtime guards.

## Controls

- [x] API keys are hashed and only issued once (`src/__tests__/api-key.service.test.ts`).
- [x] API keys are validated on every MCP request (`test/integration/mcp.test.ts` revoked key flow).
- [x] Cross-tenant isolation is enforced (`test/integration/tenant-isolation.test.ts`).
- [x] Scope filtering is enforced in SQL-backed retrieval (`test/integration/memories.test.ts`).
- [x] Authorization tokens are not logged (`test/integration/logging.test.ts`, `test/security/threat-model-verification.test.ts`).
- [x] Enrichment request/response bodies are not logged (`test/security/threat-model-verification.test.ts`).
- [x] Audit logs are append-only for non-owner roles (`test/security/threat-model-verification.test.ts` checks `PUBLIC` UPDATE/DELETE privileges).
- [x] Tenant routing is derived from authenticated agent identity, not request input (`test/security/threat-model-verification.test.ts`).

## Residual Notes

- Purge of expired audit entries is handled by the M8 retention job and should use a dedicated purge connection via `AUDIT_PURGE_DATABASE_URL` in production.
- Keep structured logging enabled in all environments where request forensics are required.
