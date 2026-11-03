# Dependency pins

## (a) Workspace version table (MVP v2)

Aligned with `docs/mvp_v2.md` and `docs/superpowers/plans/2026-10-25-phase-0-v2-reconcile.md`. All versions are pinned **exact** (`save-exact=true`).

| Package                               | Version            | Notes                                                                                                                   |
| ------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| pnpm                                  | 12.9.1             | via `packageManager` field; managed by corepack                                                                         |
| Node                                  | ≥ 24.0.0           | vitest 5 requires `^22.12 \|\| ^24`; local machine runs 24.14.1                                                         |
| nx                                    | 23.2.1             | monorepo orchestration (`typescript@5.9.3` via `packageExtensions` for project-graph tsconfig reading)                  |
| @nx/js                                | 23.2.1             | target inference from package.json scripts                                                                              |
| @nx/oxlint                            | 23.2.1             | module boundaries as oxlint JS plugin (`typescript@5.9.3` override for `@typescript-eslint`)                            |
| typescript                            | 7.0.2              | native TS 7 (`typescript-go`) — required by `@effect/tsgo`                                                              |
| typescript (JS compiler API override) | 5.9.3              | scoped override in `pnpm-workspace.yaml` for tools requiring `ts.createProgram` (`@nx/oxlint`, `nx`, `ts-morph`)        |
| @effect/tsgo                          | 0.48.0             | Effect language service + `effect-tsgo patch --oxlint` CLI                                                              |
| effect                                | 4.0.0              | v4 core (includes `effect/Graph`, `effect/Tracer`, `effect/ai/*`, `effect/http/*` subpaths)                             |
| @effect/vitest                        | 4.0.0              | peer: `effect ^4.0.0`, `vitest >=5.0.0 <6.0.0`                                                                          |
| vitest                                | 5.0.3              | test runner                                                                                                             |
| @effect/ai-typesafe                   | 4.0.0              | Clef/System One client for local Ollama (`clef-flash` 9B)                                                               |
| oxlint                                | 1.86.0             | linter (with `tools/oxlint/syntax-bans.js` and `no-restricted-imports` patterns)                                        |
| oxlint-tsgolint                       | 7.0.2003           | type-aware linting backend for oxlint                                                                                   |
| @modelcontextprotocol/sdk             | 1.32.0             | for `apps/harness-mcp` (peer `zod ^3.25 \|\| ^4.0`)                                                                     |
| zod                                   | 4.6.5              | MCP SDK peer                                                                                                            |
| alchemy                               | 2.0.0-beta.80      | Effect-native IaC (beta — pin exact, `type:infra` and `apps/sample` only)                                               |
| @effect/platform-node                 | 4.0.0              | alchemy's Node runtime                                                                                                  |
| drizzle-orm                           | 1.0.0-rc.5-ab785fc | required by `alchemy@2.0.0-beta.80` for `drizzle-orm/effect-d1` & `drizzle-orm/effect-sqlite-do`; **`type:infra` only** |
| drizzle-kit                           | 1.0.0-rc.5-ab785fc | hand-run v1 subfolder migration generation (`devDependency` of `type:infra`)                                            |
| @modernrelay/omnigraph                | 0.14.0             | local Lance-backed property graph client (`libs/harness/graph`, Phase 1)                                                |
| @modernrelay/omnigraph-mcp            | 0.14.0             | Omnigraph MCP server (`adapters/claude-code/.mcp.json`, Phase 1)                                                        |
| @ast-grep/napi                        | 0.51.0             | syntactic `Effect.fn` indexing and structural search (Phase 1)                                                          |
| ts-morph                              | 28.0.0             | type-aware `Effect<A, E, R>` and `Layer<ROut, E, RIn>` extractor over `typescript@5.9.3` (Phase 3)                      |
| @effect/sql-d1                        | 4.0.0              | peer `effect ^4.0.0` — under `Drizzle.D1` (Phase 4)                                                                     |
| @effect/sql-sqlite-do                 | 4.0.0              | peer `effect ^4.0.0` — under `Drizzle.DurableObject` (Phase 4)                                                          |
| @effect/atom-react                    | 4.0.0              | peers `react >=19 <20`, `effect ^4` — web app (Phase 4)                                                                 |
| react                                 | 19.3.0             | web app (Phase 4)                                                                                                       |
| vite                                  | 8.3.2              | web app + `Cloudflare.Website.Vite` (Phase 4)                                                                           |
| oasdiff                               | v1.33.0            | OpenAPI breaking-change gate Go binary from GitHub releases (Phase 4)                                                   |

## (b) Vendored subtree pins

`git rev-parse HEAD` immediately after each `git subtree add --squash` is the commit on this branch. `git-subtree-split` is the upstream revision named in that squash commit.

| Path            | Subtree commit (`git rev-parse HEAD`)      | Upstream (`git-subtree-split`)             | Vendored package version                                                  |
| --------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| `repos/effect`  | `5cc65948292571acac4b14ac2ff71a3dd123adb0` | `53823f2006c181a5498b61edf95ecb7998acd010` | `effect` `4.0.6` (`repos/effect/packages/effect/package.json`)            |
| `repos/alchemy` | `c0662feff7a0ac0b20b01002e31d3398bfb45895` | `7f133ecce5d03016cf33a0ab4aea543ac05bbbaa` | `alchemy` `2.0.0-beta.84` (`repos/alchemy/packages/alchemy/package.json`) |

## (c) Alchemy doc snapshots

Fetched on 2026-10-24 with `curl -fsSL https://alchemy.run/llms.txt` and `curl -fsSL https://alchemy.run/llms-full.txt`. Re-run those two commands when the subtree or pin is refreshed.

| File                         | Bytes (`wc -c`) |
| ---------------------------- | --------------- |
| `docs/alchemy-llms.txt`      | 96940           |
| `docs/alchemy-llms-full.txt` | 177000          |

`grep -c "tutorial/part" docs/alchemy-llms.txt` printed `28`.
