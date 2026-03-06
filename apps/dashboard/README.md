# Monet Dashboard

The management UI for the Monet AI agent memory system.

## Redesign with shadcn/ui

The dashboard has been upgraded to use **shadcn/ui** for a modern, consistent, and accessible design. 
It uses the "New York" style with the "Slate" color palette and full CSS variable support.

## Seeded Development Mode

To test the dashboard locally without a real OAuth provider, use the seeded development mode.

### Setup
1. Ensure you have a PostgreSQL database running and `DATABASE_URL` is set in your `.env`.
2. Ensure `ENCRYPTION_KEY` (32-byte base64) is set in your `.env`.

### Run
From the root directory:
```bash
pnpm --filter @monet/dashboard dev:seeded
```
Or from `apps/dashboard`:
```bash
pnpm dev:seeded
```

This will:
1. Run platform migrations.
2. Seed the database with a test tenant (`test-org`), a test user, multiple agents, groups, memories, rules, and audit logs.
3. Start the Next.js development server with `DEV_BYPASS_AUTH=true`.

### Login
When the login page appears, enter the organization slug:
**test-org**

This will automatically log you in as the seeded test user.
