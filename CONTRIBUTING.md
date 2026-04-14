# Contributing to Monet

Thanks for your interest in contributing to Monet.

This guide is for **external open-source contributors** and maintainers working in
the public repository.

## Where to Start

- Browse open [GitHub issues](https://github.com/team-monet/monet/issues) and pick
  something unassigned or clearly open for contribution.
- If you are proposing a change that is not tracked yet, open an issue first so
  we can align on scope before implementation.
- Use GitHub issues/PRs as the public collaboration path (there is currently no
  separate public community forum).

## Setup and Validation Entry Points

Please use the validated quickstarts/docs rather than this file as a full setup manual:

- **Local development quickstart:** [docs/local-development.md](docs/local-development.md)
- **Architecture overview:** [docs/architecture.md](docs/architecture.md)
- **Production/self-hosting reference:** [docs/production-deployment.md](docs/production-deployment.md)
- **Security policy:** [SECURITY.md](SECURITY.md)

For most contributions, follow the local quickstart and then run:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
```

If your change modifies DB schema, also include migrations and verify them:

```bash
pnpm db:generate
pnpm db:migrate
```

## Branch and Pull Request Expectations

1. Start from `main` and create a branch (`feat/...`, `fix/...`, or similar).
2. Keep each PR focused on one issue (or one tightly related change set).
3. Link the issue in the PR description (for example, `Closes #123`).
4. Include clear testing evidence (commands run + results).
5. Update docs when behavior, commands, APIs, or workflows change.

We prefer smaller, reviewable PRs over large multi-topic changes.

## DCO (Developer Certificate of Origin)

Monet uses **DCO sign-off** instead of a CLA.

Every commit in your PR must include a `Signed-off-by` trailer:

```text
Signed-off-by: Your Name <you@example.com>
```

The easiest way is to commit with `-s`:

```bash
git commit -s -m "your message"
```

If you forget, you can fix commits locally (for example with rebase) and push again.

## Reporting Bugs, Feature Requests, and Questions

Since there is no separate public community channel yet:

- **Bug reports:** open a GitHub issue with repro steps, expected behavior,
  actual behavior, and environment details.
- **Feature requests:** open a GitHub issue describing the problem/use case,
  not only the proposed implementation.
- **Questions:** open a GitHub issue using a clear `[Question]` prefix in the title.

For implementation-specific discussion, use PR comments/reviews so context stays
attached to the change.

## Security Reporting (Private)

Please **do not** report security vulnerabilities in public issues or PRs.

Use GitHub private vulnerability reporting as documented in
[SECURITY.md](SECURITY.md):

- [Report a vulnerability (private advisory)](https://github.com/team-monet/monet/security/advisories/new)

## Lightweight Triage and Contribution Etiquette

- Be respectful and assume positive intent.
- Before starting substantial work, leave a short note on the issue to avoid
  duplicate effort.
- If your plans change, unassign yourself or post an update so others can pick it up.
- Review comments should focus on code, behavior, and evidence.
- Maintainers may close stale or out-of-scope issues/PRs to keep backlog quality high.

## Additional References

- [README.md](README.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/local-development.md](docs/local-development.md)
- [docs/production-deployment.md](docs/production-deployment.md)
- [docs/observability.md](docs/observability.md)
- [SECURITY.md](SECURITY.md)
