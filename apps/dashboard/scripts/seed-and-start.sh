#!/bin/bash
# Seeds test data and starts the dashboard in dev mode
cd "$(dirname "$0")/.." 
pnpm tsx scripts/seed-test-data.ts
DEV_BYPASS_AUTH=true pnpm dev
