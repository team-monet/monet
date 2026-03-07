# Contributing to Monet

## Source of Truth

- Use GitHub Issues and Projects for active work tracking.
- Use GitHub Milestones for release scope.
- Do not create a parallel active backlog outside GitHub.

## Development Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create local env file:

```bash
cp .env.local-dev.example .env.local-dev
```

3. Start local stack:

```bash
pnpm local:up
```

4. Bootstrap tenant and local credentials:

```bash
pnpm local:bootstrap
```

## Branch and PR Flow

1. Create or pick an issue.
2. Create a feature branch from `main`.
3. Keep changes scoped to one issue or tightly related set.
4. Open PR with issue link and testing evidence.

## Quality Gates

Run before opening a PR:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
```

If you changed DB schema:

```bash
pnpm db:generate
pnpm db:migrate
```

## Coding Standards

- Keep changes small and focused.
- Preserve backward compatibility unless issue scope explicitly allows breaking changes.
- Add or update tests for behavior changes.
- Update docs when commands, APIs, or behavior change.

## Database and Migration Rules

- Schema changes must include migration artifacts in `packages/db/drizzle`.
- Runtime code must not depend on tables/columns that are not created in migrations.
- Validate migration paths from clean database state.

## API Changes

- Validate request bodies defensively and return 4xx for client input problems.
- Avoid leaking secrets in logs.
- Keep hot-path logging minimal and purposeful.

## Dashboard Changes

- Validate both local auth and tenant/admin flows.
- Verify hydration-safe markup in React components.
- Confirm navigation and action buttons are wired end-to-end.

## Local Verification for MCP + Dashboard

1. Get API key from `.local-dev/bootstrap.json`.
2. Validate MCP:

```bash
MCP_API_KEY="<apiKey>" pnpm local:mcp:smoke
```

3. Start dashboard if needed:

```bash
pnpm local:up:dashboard
```

4. Confirm dashboard login with organization `test-org`.

## CI Notes

CI runs on pushes and PRs to `main` and includes build, typecheck, lint, unit tests, integration tests, and optional perf gate.

Mirror CI behavior locally as much as possible before requesting review.
