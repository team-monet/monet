#!/usr/bin/env bash

set -euo pipefail

REPO="${1:-team-monet/monet}"
BRANCH="${2:-main}"

echo "Applying branch protection for ${REPO}:${BRANCH}..."

PAYLOAD='{
  "required_status_checks": {
    "strict": true,
    "contexts": ["build-and-test"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "required_conversation_resolution": true,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": true,
  "restrictions": null
}'

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${REPO}/branches/${BRANCH}/protection" \
  --input - <<<"${PAYLOAD}"

echo "Done. Verifying protection..."
gh api "repos/${REPO}/branches/${BRANCH}/protection" \
  -q '{required_status_checks: .required_status_checks, required_pull_request_reviews: .required_pull_request_reviews, required_conversation_resolution: .required_conversation_resolution, enforce_admins: .enforce_admins, required_linear_history: .required_linear_history, allow_force_pushes: .allow_force_pushes, allow_deletions: .allow_deletions}'
