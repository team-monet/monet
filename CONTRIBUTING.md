# Contributing

This covers the parts you cannot read off the code: which licence your contribution falls under, how to sign it off, and how to build and test.

## Which licence your contribution falls under

**It depends on where the change lands.** This repository is not under a single licence.

| Path | Licence |
|---|---|
| `packages/core`, `packages/cli` | GNU Affero General Public License v3.0 (`AGPL-3.0-only`) — [LICENSE](./LICENSE) |
| `harness/` | Apache License 2.0 — [harness/LICENSE](./harness/LICENSE) |

A change that touches both areas is contributed under both, file by file. If that distinction matters to you or to your employer, settle it before you write the patch rather than after.

## Sign off your commits (DCO)

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) — a statement that you wrote the patch, or otherwise have the right to submit it under the licence covering the files you touched.

Sign off by committing with `-s`:

```sh
git commit -s -m "your message"
```

That appends a `Signed-off-by:` line from your git `user.name` and `user.email`. Use a real name and a working address.

## Repo map

| Path | What it is |
|---|---|
| `packages/core` | The memory engine — store, retrieval, gates. Published to npm as `@team-monet/core` through `0.8.1`; that line is now deprecated, and the engine reaches users bundled inside the CLI. |
| `packages/cli` | The `monet` MCP server + CLI. This is what ships to npm as `@team-monet/monet`. |
| `harness/` | The `with-monet` agent harness — agent prompts and the install playbook. Markdown plus one dependency-free CLI stub. |

`harness/` is deliberately **not** a workspace member: no dependencies, no build, no tests. The commands below do not cover it, and CI has no gate for it.

## Build and test

pnpm is pinned in the root `package.json` `packageManager` field. CI runs Node 22; there is no `engines` floor declared, so older versions are untested rather than blocked.

```sh
pnpm install

pnpm -r typecheck
pnpm -r test
pnpm -r build
```

`pnpm -r` covers `packages/core` and `packages/cli`. For a single package:

```sh
pnpm --filter @team-monet/core test
pnpm --filter @team-monet/monet test
```

Two things worth knowing before you read a red result as a real failure:

- **The ONNX eval suites do not run by default.** `eval.onnx.test.ts`, `eval-baseline.onnx.test.ts`, `recall-floor.onnx.test.ts` and `resolution-hybrid.onnx.test.ts` are skipped unless `MONET_EVAL_ONNX=1`. That keeps the default run offline and deterministic — no model download. Set it when you are deliberately measuring the shipping semantic space.
- **`gates.test.ts > gate performance` measures time.** It calibrates against a baseline primitive in the same process and asserts ratios rather than absolute milliseconds, so it travels across hardware — but it is still a timing test, and a loaded machine can push it over. If it is your only failure, re-run it on an otherwise quiet machine before investigating.

CI (`.github/workflows/ci.yml`) runs typecheck, test, and build per package. A change under `packages/core` also runs the `cli` gate: the CLI bundle inlines core, so core code ships inside `@team-monet/monet` without a byte of `packages/cli` changing.

## Reporting a vulnerability

Not here — see [SECURITY.md](./SECURITY.md). Please do not open a public issue for a security problem.
