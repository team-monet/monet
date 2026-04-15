# Main Branch Protection (GitHub)

This document defines the baseline protection policy for `main` in Monet.

## Current repository findings

- Repository: `team-monet/monet`
- Default branch: `main`
- CI workflow: `.github/workflows/ci.yml`
- Current CI check run name to require: `build-and-test`
- Branch protection API check on current repo returned:
  - `403 Upgrade to GitHub Pro or make this repository public to enable this feature`

> Note: GitHub branch protection is free for public repos, but on private repos it depends on plan.

## Required protection policy for `main`

Apply these settings:

1. **Require a pull request before merging**
   - Required approvals: `1`
   - Dismiss stale approvals when new commits are pushed: `true`
   - Require approval of the most recent push: `true`
   - Require conversation resolution before merging: `true`
2. **Require status checks to pass before merging**
   - Required check: `build-and-test`
   - Require branches to be up to date before merging: `true` (strict mode)
3. **No direct pushes to `main`**
   - Enforced by requiring PRs + no bypass allowances
   - Apply to admins as well: `true`
4. **General safety controls**
   - Allow force pushes: `false`
   - Allow deletions: `false`
   - Require linear history: `true`

## Apply via script (recommended)

Use the repository script:

```bash
scripts/github/set-main-branch-protection.sh
```

It applies the policy above through GitHub API.

## Apply via GitHub UI (fallback)

GitHub → **Settings** → **Branches** → Add branch protection rule for `main`:

- ✅ Require a pull request before merging
  - ✅ Dismiss stale pull request approvals when new commits are pushed
  - ✅ Require approval of the most recent reviewable push
  - Required approving reviews: `1`
- ✅ Require status checks to pass before merging
  - ✅ Require branches to be up to date before merging
  - Required status checks: `build-and-test`
- ✅ Require conversation resolution before merging
- ✅ Include administrators
- ✅ Require linear history
- ❌ Allow force pushes
- ❌ Allow deletions

## Maintenance note

If CI job names change in `.github/workflows/ci.yml`, update required checks accordingly (this policy currently expects `build-and-test`).
