# Effect-TS Engineering Harness — Repo Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the empty `effect-ts-harness` repo into a pnpm + Nx monorepo with the full Effect v4 toolchain (tsgo with Effect diagnostics, oxlint with the effecttsgo preset, module boundaries, composite `verify` gate), the first harness packages with spec-backed seeds, the vendored Effect and Alchemy knowledge layers, and the Alchemy v2 sample-app scaffold — everything `docs/mvp.md` needs before phase 1 starts.

**Architecture:** pnpm workspace (`apps/*`, `libs/harness/*`, `libs/sample/*`) orchestrated by Nx 23 with targets inferred from per-package scripts. Every project exposes `typecheck`, `lint`, `test` and a composite `verify`; `nx affected -t verify` is the single definition of done. Deterministic gates: `@effect/tsgo` (TypeScript 7 native + Effect diagnostics), oxlint with the `@effect/tsgo` recommended preset and custom syntax bans, and `@nx/oxlint`'s boundaries plugin enforcing the `type:domain|service|infra|app` taxonomy. `repos/effect` and `repos/alchemy` are squashed read-only git subtrees that agents learn from instead of external docs. The sample app (`apps/sample`) declares its Cloudflare infrastructure with Alchemy v2 — `alchemy.run.ts` with a single R2 Bucket, exactly per alchemy.run's getting-started — with nothing deployed: verify runs emulated-first, deploys are human-only.

**Tech Stack:** pnpm 12.9.1 · Node ≥ 24 · Nx 23.2.1 (+ @nx/js, @nx/oxlint) · TypeScript 7.0.2 (native) · @effect/tsgo 0.48.0 · effect 4.0.0 · @effect/vitest 4.0.0 + vitest 5.0.3 · @effect/ai-typesafe 4.0.0 · oxlint 1.86.0 + oxlint-tsgolint 7.0.2003 · @modelcontextprotocol/sdk 1.32.0 · alchemy 2.0.0-beta.80 + @effect/platform-node 4.0.0 (sample app only) · drizzle-orm 0.45.3 + drizzle-kit 0.31.11 (infra only)

**Spec:** [docs/mvp.md](../../mvp.md) — the project brief this bootstrap serves. Acceptance boxes covered: "Repo and gates" (all 5), the bootstrap part of "Infrastructure (Alchemy)" (stack typechecks; guard asks a human before `alchemy deploy`/`destroy`; `repos/alchemy` pinned; credentials via profiles), and the bootstrap part of "Application stack" (the `type:contract` taxonomy with boundaries, the `drizzle-orm` import ban, the Drizzle migration drift gate with destructive-SQL escalation). The remaining "Runtime traces", "Effect graph", "Decision model", "Agent loop" and Application-stack boxes need the real sample feature (HttpApi/RpcGroup endpoints, D1/Durable Object repositories, React app) and are phase 1+ — this plan pins their dependencies and lays the gate/config groundwork.

## Global Constraints

Checked against the npm registry on **2026-10-04**; these are the highest available versions and are pinned **exact** (no carets — `effect/ai` and `@effect/ai-typesafe` are `@stability unstable`, mvp.md requires pinning):

| Package                   | Version       | Notes                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm                      | 12.9.1        | via `packageManager` field; local 11.21.0 is superseded by corepack                                                                                                                                                                                                                                                                                     |
| Node                      | ≥ 24.0.0      | vitest 5 requires `^22.12 \|\| ^24`; local machine runs 24.14.1                                                                                                                                                                                                                                                                                         |
| nx                        | 23.2.1        | monorepo orchestration                                                                                                                                                                                                                                                                                                                                  |
| @nx/js                    | 23.2.1        | target inference from package.json scripts                                                                                                                                                                                                                                                                                                              |
| @nx/oxlint                | 23.2.1        | module boundaries as oxlint JS plugin (experimental upstream)                                                                                                                                                                                                                                                                                           |
| typescript                | 7.0.2         | native TS 7 (typescript-go) — required by @effect/tsgo                                                                                                                                                                                                                                                                                                  |
| @effect/tsgo              | 0.48.0        | Effect language service + `effect-tsgo patch` CLI                                                                                                                                                                                                                                                                                                       |
| effect                    | 4.0.0         | v4 core (includes `effect/ai/*`, `effect/http/*` subpaths)                                                                                                                                                                                                                                                                                              |
| @effect/vitest            | 4.0.0         | peer: effect ^4.0.0, vitest >=5.0.0 <6.0.0                                                                                                                                                                                                                                                                                                              |
| vitest                    | 5.0.3         | test runner                                                                                                                                                                                                                                                                                                                                             |
| @effect/ai-typesafe       | 4.0.0         | Clef/System One client for Ollama                                                                                                                                                                                                                                                                                                                       |
| oxlint                    | 1.86.0        | linter                                                                                                                                                                                                                                                                                                                                                  |
| oxlint-tsgolint           | 7.0.2003      | type-aware linting backend for oxlint                                                                                                                                                                                                                                                                                                                   |
| @modelcontextprotocol/sdk | 1.32.0        | for `apps/harness-mcp` (peer zod ^3.25 \|\| ^4.0)                                                                                                                                                                                                                                                                                                       |
| zod                       | 4.6.5         | MCP SDK peer                                                                                                                                                                                                                                                                                                                                            |
| alchemy                   | 2.0.0-beta.80 | Effect-native IaC (latest tag, published 2026-10-02); **beta — pin exact**, sample app only                                                                                                                                                                                                                                                             |
| @effect/platform-node     | 4.0.0         | alchemy's Node runtime per getting-started install set                                                                                                                                                                                                                                                                                                  |
| drizzle-orm               | 0.45.3        | D1 / Durable Object queries via `alchemy/Drizzle`; **infra libraries only**                                                                                                                                                                                                                                                                             |
| drizzle-kit               | 0.31.11       | hand-run migration generation (devDependency of infra)                                                                                                                                                                                                                                                                                                  |
| @effect/sql-d1            | 4.0.0         | peer `effect ^4.0.0` ✔ — under `alchemy/Drizzle`'s `Drizzle.D1` driver (installed in phase 2 with the D1 repository)                                                                                                                                                                                                                                    |
| @effect/sql-sqlite-do     | 4.0.0         | peer `effect ^4.0.0` ✔ — under `Drizzle.DurableObject` (installed in phase 2)                                                                                                                                                                                                                                                                           |
| @effect/atom-react        | 4.0.0         | peers react ≥19 <20, effect ^4 — web app (installed in phase 2)                                                                                                                                                                                                                                                                                         |
| react                     | 19.3.0        | web app (installed in phase 2)                                                                                                                                                                                                                                                                                                                          |
| vite                      | 8.3.2         | web app + `Cloudflare.Website.Vite` (installed in phase 2)                                                                                                                                                                                                                                                                                              |
| oasdiff                   | v1.33.0       | breaking-change gate — **Go binary from [GitHub releases](https://github.com/oasdiff/oasdiff/releases), NOT npm**: the npm `oasdiff` package is a "Reserved name placeholder. No functionality." Install via brew/binary download; record the exact version in `docs/dependency-pins.md`. Gate wiring is phase 2 (needs the contract's `openapi.json`). |

- **pnpm only.** No npm/yarn invocations; `packageManager: "pnpm@12.9.1"` enforces the version via corepack.
- **Exact pins everywhere** (`.npmrc` `save-exact=true`). Re-pin deliberately when upgrading.
- **Effect v4 packages only:** `effect`, `@effect/vitest`, `@effect/ai-typesafe`. **Do NOT install `@effect/platform`, `@effect/cli` or `@effect/ai`** — their latest versions (0.97.2 / 0.77.2 / 0.37.0) peer on `effect: ^3.22.2` and are incompatible with effect 4.0.0 as of 2026-10-04. `ts-morph` 28.0.0 is deferred to phase 3 (type-aware extractor).
- **effect/ai is unstable:** only `libs/harness/decision` may import `effect/ai/Decision`, `effect/ai/DecisionModel` and `@effect/ai-typesafe` (mvp.md "Decisions" + risk table).
- **Alchemy is beta and scope-limited:** pin `2.0.0-beta.80` exact; only `apps/sample` (and later the sample's `type:infra` code) may depend on it — harness core (`libs/harness/*`) never imports alchemy (mvp.md: "a tool the sample app uses, not part of the harness core").
- **Cloud resources only where infra lives:** Alchemy resources and bindings may appear only in `type:infra` libraries and the app's `alchemy.run.ts`; a `type:domain` library never creates or binds a cloud resource (mvp.md infra policy; enforced by `effect-graph:check` from phase 3).
- **Contract-first taxonomy (mvp.md "Application stack"):** `type:contract` holds shared Schemas, `HttpApi`, `RpcGroup`s and API errors and imports `effect` only; `type:domain` imports `contract`; `type:service` imports `contract`+`domain`; `type:infra` imports everything except `type:app`; the future `web` app may import only `contract` and UI libraries (constraint wired when the web app exists).
- **Drizzle stays in infra:** `drizzle-orm` and table schemas (`sqliteTable`) are imported only in `type:infra` (oxlint import ban from Task 4, proven in Task 11; the `R`-manifest half comes with `effect-graph:check` in phase 3). Repositories decode rows into contract Schemas, so Drizzle types never reach the domain or the frontend. Kysely and Postgres/Hyperdrive are mvp non-goals — never install them.
- **Migrations are hand-generated and committed:** `drizzle-kit generate` runs in development, its output is committed, deploys only apply it (`Drizzle.Schema` deploy-time generation is not used — CI cannot answer drizzle-kit's interactive drift questions). `verify` gains a drift check: generating into a temp folder must add nothing; drift containing `DROP`/table-rebuild escalates to the human (exit code 2).
- **oasdiff semantics (phase 2 wiring):** `oasdiff breaking` compares the contract's committed `openapi.json` against `main`; level ERR escalates to the human, level WARN becomes a note; it runs only when `nx affected` touches the contract.
- **Cloudflare credentials live in Alchemy profiles, never in the environment:** `alchemy profile edit --add Cloudflare` (or the first `alchemy deploy`) prompts interactively for OAuth or an API token and saves to `~/.alchemy/profiles.json`. Never instruct anyone to export `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN`, never put them in `.env`.
- **Deploys are human-only:** `alchemy deploy`, `alchemy destroy` and profile commands always ask a human (guard verdict `ask`); every deploy is confirmed individually, never batched — matching Alchemy's own advice. Bootstrap and MVP verify run emulated, nothing deployed.
- **Alchemy docs are vendored, not fetched:** `llms.txt` (index) and `llms-full.txt` (per-resource reference) are snapshotted at pin time into `docs/alchemy-llms.txt` and `docs/alchemy-llms-full.txt`, and the agent reads those — the live site always documents the newest release, which drifts from our pinned `2.0.0-beta.80` (the same reason mvp.md rejects unpinned external docs), and lookups must work offline and in CI. The HTTP sources are used only to refresh the snapshots when the pin/subtree is updated. Tutorial: [part-1](https://alchemy.run/cloudflare/tutorial/part-1) … [part-5](https://alchemy.run/cloudflare/tutorial/part-5).
- **`repos/` is read-only:** never edit `repos/effect` or `repos/alchemy`, never import from them; excluded from search, watching, auto-imports, lint and Nx inference (mvp.md "Knowledge layer").
- **Custom bans inside `libs/**` and `apps/**` `src/`:** no `async`/`await`, no `new Promise`, no `try`/`catch`, no `throw`, no raw `JSON.parse` (mvp.md "Gates and feedback"). One escape hatch: an `oxlint-disable` comment at a foreign boundary only.
- **Definition of done:** `nx affected -t verify` green (mvp.md "Gates and feedback").
- Prerequisites on the machine: pnpm (via corepack), Docker (code-graph-rag, later phases), Ollama + `clef-flash` model (phase 2, not needed to pass this plan), a Cloudflare account **only** when a human actually runs `alchemy dev`/`deploy` — nothing in this plan's verify needs one.

---

### Task 1: pnpm workspace foundation

**Files:**

- Modify: `package.json` (replace WebStorm scaffold)
- Create: `.npmrc`, `pnpm-workspace.yaml`, `.gitignore` (rewrite)
- Delete: `src/index.ts`, `tsconfig.json` (old single-package scaffold; replaced by Task 2's `tsconfig.base.json`)

**Interfaces:**

- Consumes: nothing (first task).
- Produces: pnpm 12.9.1 workspace with `apps/*`, `libs/harness/*`, `libs/sample/*` globs; `.npmrc` with `save-exact=true`; clean git baseline on branch `main`.

- [ ] **Step 1: Establish git baseline.** The repo is in detached HEAD with staged but uncommitted files.

```bash
git switch -c main 2>/dev/null || git switch main
git add -A
git commit -m "chore: initial scaffold" --no-verify
```

Expected: initial commit created on `main` containing the staged scaffold files.

- [ ] **Step 2: Replace `package.json`** with the workspace root manifest (no dependencies yet — `prepare` is added in Task 2 once `@effect/tsgo` exists):

```json
{
  "name": "effect-ts-harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.9.1",
  "engines": {
    "node": ">=24.0.0"
  }
}
```

- [ ] **Step 3: Create `.npmrc`:**

```
save-exact=true
```

- [ ] **Step 4: Create `pnpm-workspace.yaml`:**

```yaml
packages:
  - apps/*
  - libs/harness/*
  - libs/sample/*
onlyBuiltDependencies:
  - esbuild
```

- [ ] **Step 5: Rewrite `.gitignore`** — note `.vscode/*` must stay ignored **except** `settings.json` (Task 7 commits it), and add `.idea/`, `.nx/`, `.env`:

```gitignore
node_modules/
dist/
coverage/
.nx/
.vite/
.alchemy/
*.tsbuildinfo

.env
.env.*
!.env.example

.vscode/*
!.vscode/settings.json

.idea/
.DS_Store
```

- [ ] **Step 6: Remove the old scaffold** and verify the toolchain:

```bash
git rm -r src tsconfig.json
corepack enable
pnpm install
```

Expected: `pnpm -v` prints `12.9.1`; `pnpm install` exits 0 and creates `pnpm-lock.yaml`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: pnpm workspace foundation (pnpm 12.9.1, node >=24, save-exact)"
```

---

### Task 2: Toolchain dependencies, Nx 23, tsconfig.base, prepare patch

**Files:**

- Modify: `package.json` (devDependencies + scripts)
- Create: `nx.json`, `tsconfig.base.json`

**Interfaces:**

- Consumes: workspace from Task 1.
- Produces: `tsconfig.base.json` that every project tsconfig extends (strict, `nodenext`, `@effect/language-service` plugin with Effect diagnostics gating tsc's exit code); `nx.json` with `@nx/js` target inference and `repos/**` excluded; root scripts `prepare`, `lint`, `verify`, `verify:all`.

- [ ] **Step 1: Install the toolchain with exact versions:**

```bash
pnpm add -D -w nx@23.2.1 @nx/js@23.2.1 typescript@7.0.2 @effect/tsgo@0.48.0 oxlint@1.86.0 oxlint-tsgolint@7.0.2003 vitest@5.0.3
```

- [ ] **Step 2: Write `nx.json`:**

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "defaultBase": "main",
  "ignore": ["repos/**", "docs/**", "agent-patterns/**", "adapters/**"],
  "plugins": ["@nx/js"],
  "namedInputs": {
    "sharedGlobals": ["{workspaceRoot}/tsconfig.base.json", "{workspaceRoot}/.oxlintrc.json"],
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": ["default"]
  },
  "targetDefaults": {
    "typecheck": { "cache": true },
    "lint": { "cache": true },
    "test": { "cache": true },
    "verify": { "cache": true }
  }
}
```

- [ ] **Step 3: Write `tsconfig.base.json`.** `module: nodenext` is mandatory — effect 4.0.0 ships an exports-map-only package (no `main`/`types` fields). The plugin options raise Effect diagnostics so they block the gate (`floatingEffect` confirmed as a rule name in the tsgo README; `diagnostics: false` silences the editor LSP channel so oxlint does not duplicate it, per mvp.md's gate table):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": false,
        "diagnosticSeverity": { "floatingEffect": "error" },
        "ignoreEffectSuggestionsInTscExitCode": true,
        "ignoreEffectWarningsInTscExitCode": false,
        "ignoreEffectErrorsInTscExitCode": false
      }
    ]
  }
}
```

- [ ] **Step 4: Extend root `package.json`** — add `scripts` and `devDependencies` (final state after Step 1):

```json
{
  "name": "effect-ts-harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.9.1",
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "prepare": "effect-tsgo patch --oxlint",
    "lint": "oxlint .",
    "verify": "nx affected -t verify",
    "verify:all": "nx run-many -t verify"
  },
  "devDependencies": {
    "@effect/tsgo": "0.48.0",
    "@nx/js": "23.2.1",
    "nx": "23.2.1",
    "oxlint": "1.86.0",
    "oxlint-tsgolint": "7.0.2003",
    "typescript": "7.0.2",
    "vitest": "5.0.3"
  }
}
```

- [ ] **Step 5: Run the patch and verify the toolchain:**

```bash
pnpm install
pnpm nx --version
pnpm exec tsc --version
```

Expected: `pnpm install` output shows the `prepare` hook running `effect-tsgo patch --oxlint` and reporting patched TypeScript and oxlint files; `nx` reports 23.2.x; `tsc` reports 7.0.2. If pnpm prints "Ignored build scripts" for any package, add its name to `onlyBuiltDependencies` in `pnpm-workspace.yaml` and rerun `pnpm install`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: nx 23 + typescript 7 + @effect/tsgo toolchain with prepare patch"
```

---

### Task 3: First library (`@harness/sample-domain`) + Effect v4 smoke + floating-effect gate proof

**Files:**

- Create: `libs/sample/domain/package.json`, `libs/sample/domain/tsconfig.json`, `libs/sample/domain/vitest.config.ts`, `libs/sample/domain/src/index.ts`, `libs/sample/domain/test/index.test.ts`
- Create (temporary, deleted in Step 4): `libs/sample/domain/src/floating-scratch.ts`

**Interfaces:**

- Consumes: `tsconfig.base.json` (Task 2), workspace globs (Task 1).
- Produces: package `@harness/sample-domain` (Nx tag `type:domain`) with scripts `typecheck` / `lint` / `test` / `verify`; exports `GreetInput` (Schema) and `greet` (`Effect.fn`). Later tasks reuse this package for boundary and ban proofs.

- [ ] **Step 1: Write `libs/sample/domain/package.json`:**

```json
{
  "name": "@harness/sample-domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:domain"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test"
  },
  "dependencies": {
    "effect": "4.0.0"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "vitest": "5.0.3"
  }
}
```

- [ ] **Step 2: Write `libs/sample/domain/tsconfig.json` and `vitest.config.ts`:**

```json
{
  "extends": "../../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
```

- [ ] **Step 3: Write the domain source and its test.**

`libs/sample/domain/src/index.ts`:

```ts
import { Effect, Schema } from "effect"

export const GreetInput = Schema.Struct({ name: Schema.String })
export type GreetInput = typeof GreetInput.Type

export const greet = Effect.fn("Sample.greet")(function* (input: GreetInput) {
  return `Hello, ${input.name}!`
})
```

`libs/sample/domain/test/index.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { greet } from "../src/index.js"

describe("greet", () => {
  it.effect("greets by name", () =>
    Effect.gen(function* () {
      const out = yield* greet({ name: "Roman" })
      expect(out).toBe("Hello, Roman!")
    }),
  )
})
```

- [ ] **Step 4: Prove the floating-effect gate (mvp.md acceptance box 1).** Write `libs/sample/domain/src/floating-scratch.ts`:

```ts
import { Effect } from "effect"

export const scratch = (): void => {
  Effect.log("x")
}
```

Run the failing check first:

```bash
pnpm install
pnpm nx run @harness/sample-domain:typecheck
```

Expected: **FAIL** with a floating-effect diagnostic from the Effect language service (unassigned `Effect.log("x")` — an effect left unyielded/unassigned). If typecheck passes instead, remove `"diagnostics": false` from `tsconfig.base.json`'s plugin block (it must not suppress the tsc channel), rerun, and keep the variant that fails. Then delete the scratch file and confirm green:

```bash
rm libs/sample/domain/src/floating-scratch.ts
pnpm nx run @harness/sample-domain:typecheck
```

Expected: PASS.

- [ ] **Step 5: Run the test and the composite verify:**

```bash
pnpm nx run @harness/sample-domain:test
pnpm nx run @harness/sample-domain:verify
```

Expected: both PASS (1 test green; verify = typecheck + lint + test). If `pnpm nx run` does not find the project, run `pnpm nx reset` once and retry (stale Nx daemon cache). If `it.effect` / the `@effect/vitest` import shape has changed in v4, correct it against `repos/effect` or the `@effect/vitest` package exports — keep the assertion body identical.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(sample-domain): first type:domain lib, Effect v4 smoke test, floating-effect gate proof"
```

---

### Task 4: oxlint with effecttsgo preset + custom syntax bans

**Files:**

- Create: `.oxlintrc.json` (workspace root)
- Create (temporary, deleted in Step 3): `libs/sample/domain/src/ban-scratch.ts`

**Interfaces:**

- Consumes: `@effect/tsgo`'s oxlint preset (installed in Task 2), libs/apps layout.
- Produces: root `.oxlintrc.json` that every project's `lint` script picks up; the five custom bans with a single documented escape hatch.

- [ ] **Step 1: Write `.oxlintrc.json`:**

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "extends": ["./node_modules/@effect/tsgo/oxlint-presets/recommended.json"],
  "ignorePatterns": ["repos/**", "node_modules/**", "dist/**", "coverage/**"],
  "overrides": [
    {
      "files": ["libs/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      "rules": {
        "no-restricted-syntax": [
          "error",
          {
            "selector": "FunctionDeclaration[async=true], FunctionExpression[async=true], ArrowFunctionExpression[async=true]",
            "message": "No async/await in Effect code — use Effect.gen. Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "NewExpression[callee.name='Promise']",
            "message": "No `new Promise` — wrap callbacks with Effect.try or Effect.async. Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "TryStatement",
            "message": "No try/catch in Effect code — model failures with typed errors (Effect.catch*, Effect.die). Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "ThrowStatement",
            "message": "No throw in Effect code — use Effect.fail or Effect.die. Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
            "message": "No raw JSON.parse — decode with Schema (Schema.decodeUnknown*). Escape hatch: an oxlint-disable comment, foreign boundaries only."
          }
        ],
        "no-restricted-imports": [
          "error",
          {
            "paths": [
              {
                "name": "drizzle-orm",
                "message": "drizzle-orm is infra-only — import it only in type:infra libraries; repositories decode rows into contract Schemas (mvp.md, Application stack). Escape hatch: an oxlint-disable comment, foreign boundaries only."
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["**/infra/src/**/*.ts", "**/infra/test/**/*.ts"],
      "rules": {
        "no-restricted-imports": "off"
      }
    }
  ]
}
```

- [ ] **Step 2: Verify the Effect preset lints clean on the existing lib:**

```bash
pnpm exec oxlint .
```

Expected: exits 0, no diagnostics in `libs/sample/domain`. (The `recommended.json` preset from `@effect/tsgo` enables oxlint's type-aware mode via `oxlint-tsgolint` and the `effecttsgo` rules.)

- [ ] **Step 3: Prove each ban (mvp.md acceptance box 4).** Write `libs/sample/domain/src/ban-scratch.ts` (not under an `infra/` path, so the drizzle import ban applies too; the package does not need drizzle-orm installed — `no-restricted-imports` is a static rule):

```ts
import { integer } from "drizzle-orm"

export const scratch = async (): Promise<string> => {
  try {
    const parsed: unknown = JSON.parse('{"a":1}')
    return String(parsed)
  } catch (error) {
    throw error
  }
}

export const deferred = (): Promise<number> => new Promise((resolve) => resolve(1))

export const column = integer("id")
```

Run: `pnpm exec oxlint .`
Expected: **FAIL** with `no-restricted-syntax` errors reporting all five messages (async/await, new Promise, try/catch, throw, JSON.parse) plus a `no-restricted-imports` error for `drizzle-orm`. Then delete the scratch file and confirm green:

```bash
rm libs/sample/domain/src/ban-scratch.ts
pnpm exec oxlint .
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(gates): oxlint effecttsgo preset + syntax bans for async/try/throw/new Promise/JSON.parse"
```

---

### Task 5: Nx module boundaries gate + `@harness/sample-infra`

**Files:**

- Modify: `.oxlintrc.json` (add `jsPlugins` + boundaries rule)
- Create: `libs/sample/infra/package.json`, `libs/sample/infra/tsconfig.json`, `libs/sample/infra/vitest.config.ts`, `libs/sample/infra/src/index.ts`, `libs/sample/infra/test/index.test.ts`
- Modify (temporary, reverted in Step 4): `libs/sample/domain/package.json`, `libs/sample/domain/src/index.ts`

**Interfaces:**

- Consumes: `.oxlintrc.json` (Task 4), tags mechanism from Task 3's `nx.tags`.
- Produces: package `@harness/sample-infra` (tag `type:infra`) exporting `logToConsole`; enforced depConstraints `type:contract → contract only`, `type:domain → contract+domain`, `type:service → contract+domain+service`, `type:infra → contract+domain+service+infra`, `type:app → all` (the future `web` app gets a stricter `scope:web` constraint when it exists, phase 2).

- [ ] **Step 1: Register the boundaries plugin** (also installs `@nx/oxlint` and may extend `.oxlintrc.json`):

```bash
pnpm nx add @nx/oxlint
```

Inspect what the generator added to `.oxlintrc.json` (`jsPlugins` key and rule name). If it registered the boundaries rule under a name other than `@nx/enforce-module-boundaries`, keep **its** name in Step 2's `rules` block.

- [ ] **Step 2: Merge `.oxlintrc.json`** to the final state (preset + jsPlugins + boundaries with the contract-first taxonomy from mvp.md's "Application stack" + bans):

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "extends": ["./node_modules/@effect/tsgo/oxlint-presets/recommended.json"],
  "jsPlugins": ["@nx/oxlint/boundaries-plugin"],
  "ignorePatterns": ["repos/**", "node_modules/**", "dist/**", "coverage/**"],
  "rules": {
    "@nx/enforce-module-boundaries": [
      "error",
      {
        "enforceBuildableLibDependency": true,
        "depConstraints": [
          { "sourceTag": "type:contract", "onlyDependOnLibsWithTags": ["type:contract"] },
          {
            "sourceTag": "type:domain",
            "onlyDependOnLibsWithTags": ["type:contract", "type:domain"]
          },
          {
            "sourceTag": "type:service",
            "onlyDependOnLibsWithTags": ["type:contract", "type:domain", "type:service"]
          },
          {
            "sourceTag": "type:infra",
            "onlyDependOnLibsWithTags": [
              "type:contract",
              "type:domain",
              "type:service",
              "type:infra"
            ]
          },
          {
            "sourceTag": "type:app",
            "onlyDependOnLibsWithTags": [
              "type:contract",
              "type:domain",
              "type:service",
              "type:infra",
              "type:app"
            ]
          },
          { "sourceTag": "*", "onlyDependOnLibsWithTags": ["*"] }
        ]
      }
    ]
  },
  "overrides": [
    {
      "files": ["libs/**/src/**/*.ts", "apps/**/src/**/*.ts"],
      "rules": {
        "no-restricted-syntax": [
          "error",
          {
            "selector": "FunctionDeclaration[async=true], FunctionExpression[async=true], ArrowFunctionExpression[async=true]",
            "message": "No async/await in Effect code — use Effect.gen. Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "NewExpression[callee.name='Promise']",
            "message": "No `new Promise` — wrap callbacks with Effect.try or Effect.async. Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "TryStatement",
            "message": "No try/catch in Effect code — model failures with typed errors (Effect.catch*, Effect.die). Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "ThrowStatement",
            "message": "No throw in Effect code — use Effect.fail or Effect.die. Escape hatch: an oxlint-disable comment, foreign boundaries only."
          },
          {
            "selector": "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
            "message": "No raw JSON.parse — decode with Schema (Schema.decodeUnknown*). Escape hatch: an oxlint-disable comment, foreign boundaries only."
          }
        ],
        "no-restricted-imports": [
          "error",
          {
            "paths": [
              {
                "name": "drizzle-orm",
                "message": "drizzle-orm is infra-only — import it only in type:infra libraries; repositories decode rows into contract Schemas (mvp.md, Application stack). Escape hatch: an oxlint-disable comment, foreign boundaries only."
              }
            ]
          }
        ]
      }
    },
    {
      "files": ["**/infra/src/**/*.ts", "**/infra/test/**/*.ts"],
      "rules": {
        "no-restricted-imports": "off"
      }
    }
  ]
}
```

- [ ] **Step 3: Write `@harness/sample-infra`.**

`libs/sample/infra/package.json`:

```json
{
  "name": "@harness/sample-infra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:infra"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test"
  },
  "dependencies": {
    "effect": "4.0.0"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "vitest": "5.0.3"
  }
}
```

`libs/sample/infra/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`libs/sample/infra/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
```

`libs/sample/infra/src/index.ts` (return type is inferred — no hand-written Effect type annotations anywhere, the v4 type namespace is taken from inference):

```ts
import { Effect } from "effect"

export const logToConsole = (message: string) =>
  Effect.sync(() => {
    console.log(message)
  })
```

`libs/sample/infra/test/index.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { logToConsole } from "../src/index.js"

describe("logToConsole", () => {
  it.effect("runs without failing", () =>
    Effect.gen(function* () {
      yield* logToConsole("harness")
      expect(true).toBe(true)
    }),
  )
})
```

Run: `pnpm install && pnpm nx run-many -t verify -p @harness/sample-domain @harness/sample-infra`
Expected: both projects PASS.

- [ ] **Step 4: Prove the boundary gate (mvp.md acceptance box 3).** Temporarily add to `libs/sample/domain/package.json` dependencies:

```json
"@harness/sample-infra": "workspace:*"
```

and to the top of `libs/sample/domain/src/index.ts`:

```ts
import { logToConsole } from "@harness/sample-infra"
```

Run: `pnpm nx reset && pnpm nx run-many -t lint`
Expected: **FAIL** with an `enforce-module-boundaries` violation — a project tagged `type:domain` depending on a project tagged `type:infra`. If lint passes, the boundaries plugin is not active: check the rule name registered by `pnpm nx add @nx/oxlint` (Step 1) and the `jsPlugins` entry, then rerun. Revert both temporary edits and confirm green:

```bash
pnpm nx run-many -t lint
```

Expected: PASS.

- [ ] **Step 5: Verify the affected pipeline end-to-end:**

```bash
pnpm verify:all
```

Expected: `verify` target green for `@harness/sample-domain` and `@harness/sample-infra`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(gates): nx module boundaries via @nx/oxlint + type:domain/infra sample pair proof"
```

---

### Task 6: Harness package seeds (`ingest`, `decision`, `gates`) + app skeletons (`harness-cli`, `harness-mcp`)

**Files:**

- Create: `libs/harness/ingest/{package.json,tsconfig.json,vitest.config.ts}`, `libs/harness/ingest/src/trace-format.ts`, `libs/harness/ingest/test/trace-format.test.ts`
- Create: `libs/harness/decision/{package.json,tsconfig.json,vitest.config.ts}`, `libs/harness/decision/src/idiom-router.ts`, `libs/harness/decision/test/idiom-router.test.ts`
- Create: `libs/harness/gates/{package.json,tsconfig.json,vitest.config.ts}`, `libs/harness/gates/src/policy.ts`, `libs/harness/gates/test/policy.test.ts`
- Create: `apps/harness-cli/{package.json,tsconfig.json,vitest.config.ts}`, `apps/harness-cli/src/index.ts`, `apps/harness-cli/test/index.test.ts`
- Create: `apps/harness-mcp/{package.json,tsconfig.json,vitest.config.ts}`, `apps/harness-mcp/src/server.ts`, `apps/harness-mcp/test/server.test.ts`

**Interfaces:**

- Consumes: tags/gates from Tasks 3–5; mvp.md's trace interchange format, idiom-router sketch and guard table.
- Produces:
  - `@harness/ingest` (`type:service`): `TRACE_FORMAT_VERSION`, `TraceHeader` (Schema), `makeTraceHeader(repoRoot: string): TraceHeader` — phase 1 builds the name index and converter on this.
  - `@harness/decision` (`type:service`): `IdiomRouterV1` (Decision definition), `routeStep`, `IDIOM_BLOCKS`, `LocalDecisionModel` — only package allowed to import `effect/ai/*` and `@effect/ai-typesafe`.
  - `@harness/gates` (`type:service`): `classifyCommand(cmd: string): "allow" | "deny" | "escalate"` plus `ALLOWLIST` / `DENYLIST` seed data.
  - `harness-cli` (`type:app`): runnable `node src/index.ts <command>` with command registry `guard|route|done|ingest|verify|session|help`.
  - `harness-mcp` (`type:app`): `createServer()` returning an MCP SDK `McpServer` (tools added in phase 2).

- [ ] **Step 1: Write `libs/harness/ingest` package files.**

`package.json`:

```json
{
  "name": "@harness/ingest",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:service"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test"
  },
  "dependencies": {
    "effect": "4.0.0"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "vitest": "5.0.3"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
```

`src/trace-format.ts` (interchange format exactly as mvp.md specifies — `TRACE_FORMAT_VERSION = 1`, `tracer: "effect-span"`, `sampled: false`):

```ts
import { Schema } from "effect"

export const TRACE_FORMAT_VERSION = 1

export const TraceHeader = Schema.Struct({
  kind: Schema.Literal("header"),
  version: Schema.Literal(1),
  language: Schema.String,
  repo_root: Schema.String,
  tracer: Schema.String,
  sampled: Schema.Boolean,
})
export type TraceHeader = typeof TraceHeader.Type

export const makeTraceHeader = (repoRoot: string): TraceHeader => ({
  kind: "header",
  version: TRACE_FORMAT_VERSION,
  language: "javascript",
  repo_root: repoRoot,
  tracer: "effect-span",
  sampled: false,
})
```

`test/trace-format.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { makeTraceHeader, TraceHeader, TRACE_FORMAT_VERSION } from "../src/trace-format.js"

describe("trace format", () => {
  it("emits the v1 effect-span header with sampled:false", () => {
    expect(TRACE_FORMAT_VERSION).toBe(1)
    const header = makeTraceHeader("/repo")
    expect(header).toEqual({
      kind: "header",
      version: 1,
      language: "javascript",
      repo_root: "/repo",
      tracer: "effect-span",
      sampled: false,
    })
  })

  it("decodes a produced header against its Schema", () => {
    const decoded = Schema.decodeUnknownSync(TraceHeader)(makeTraceHeader("/repo"))
    expect(decoded.tracer).toBe("effect-span")
  })
})
```

(If `Schema.decodeUnknownSync` was renamed in v4, look it up in `repos/effect/packages/effect/src/Schema.ts` after Task 7 vendors it — per the AGENTS.md authority order — and adjust only the decode call; the assertions stay identical.)

- [ ] **Step 2: Write `libs/harness/decision` package files.**

`package.json`:

```json
{
  "name": "@harness/decision",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:service"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test"
  },
  "dependencies": {
    "effect": "4.0.0",
    "@effect/ai-typesafe": "4.0.0"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "vitest": "5.0.3"
  }
}
```

`tsconfig.json` and `vitest.config.ts`: byte-for-byte the same as the ingest package above (Step 1).

`src/idiom-router.ts` — the versioned definition verbatim from mvp.md's sketch ("check against the pinned source" is done at typecheck time: `Decision.make` validates the definition's shape at compile time):

```ts
import { Effect, Layer, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"

/** Ordered building blocks; `review` first is a deliberate mitigation for Clef-flash's
 * weak out-of-scope detection (ties follow option order, mvp.md "Decision model"). */
export const IDIOM_BLOCKS = [
  "review",
  "schedule",
  "stream",
  "scope",
  "queue",
  "concurrency",
  "schema",
  "effect",
] as const
export type IdiomBlock = (typeof IDIOM_BLOCKS)[number]

/** Versioned decision definition: reviewed data, not a prompt string. */
export const IdiomRouterV1 = Decision.make({
  input: Schema.Struct({ planStep: Schema.String }),
  decisions: {
    fitsAny: Decision.probability({
      instructions: "Does this step map to a single Effect building block?",
    }),
    block: Decision.classify({
      instructions: "Which Effect building block best implements this step?",
      criteria: {
        review: "Unclear or spans multiple blocks",
        schedule: "Retries, repetition, backoff, timing policies",
        stream: "Incremental or unbounded sequences of values",
        scope: "Acquiring and releasing resources",
        queue: "Producer/consumer handoff, PubSub",
        concurrency: "Forking fibers, racing, parallel work",
        schema: "Decoding, encoding, validating data at a boundary",
        effect: "Plain sequential effectful logic",
      },
    }),
  },
})

export const routeStep = Effect.fn("Harness.routeStep")(function* (planStep: string) {
  const { answers } = yield* DecisionModel.decide(IdiomRouterV1, { input: { planStep } })
  yield* Effect.annotateCurrentSpan({
    "decision.definition": "IdiomRouterV1",
    "decision.block": answers.block.label,
    "decision.fitsAny": answers.fitsAny.probability,
  })
  return answers.fitsAny.probability >= 0.7 ? answers.block.label : "review"
})

/** Local Clef-flash through Ollama's System One endpoint. */
export const LocalDecisionModel = TypeSafeDecisionModel.layer({ model: "clef-flash" }).pipe(
  Layer.provide(TypeSafeClient.layer({ apiUrl: "http://localhost:11434/v1" })),
  Layer.provide(FetchHttpClient.layer),
)
```

`test/idiom-router.test.ts` (shape-independent assertions on data we own; Ollama-dependent behavior is phase 2):

```ts
import { describe, expect, it } from "vitest"
import { IDIOM_BLOCKS } from "../src/idiom-router.js"

describe("IdiomRouterV1 data constraints", () => {
  it("puts review first (tie-break mitigation)", () => {
    expect(IDIOM_BLOCKS[0]).toBe("review")
  })

  it("stays within Ollama's 26-option limit", () => {
    expect(IDIOM_BLOCKS.length).toBeLessThanOrEqual(26)
    expect(IDIOM_BLOCKS.length).toBeGreaterThan(1)
  })
})
```

- [ ] **Step 3: Write `libs/harness/gates` package files.**

`package.json`: as Task 6 Step 1's, with `"name": "@harness/gates"`, tag `type:service`, dependency `effect` only.

`tsconfig.json` and `vitest.config.ts`: byte-for-byte the same as the ingest package above (Step 1).

`src/policy.ts` — deterministic-first guard seed from mvp.md's Clef touchpoint table (allowlist `nx`/`pnpm test`, denylist `rm -rf`, `.env`, `push --force`; unknown commands escalate to the decision model). Bootstrap seed keeps matching deliberately simple — deny on any denylist token; workspace-relative `rm -rf` refinement lands with the real guard in phase 2:

```ts
/** Deterministic guard policy. `classifyCommand` never calls the decision model:
 * "escalate" means "deterministic rules left this open" (mvp.md, safety guard row). */

export type GuardVerdict = "allow" | "deny" | "escalate"

export const ALLOWLIST: ReadonlyArray<string> = ["nx ", "pnpm test", "pnpm nx ", "pnpm verify"]

export const DENYLIST: ReadonlyArray<{ readonly token: string; readonly reason: string }> = [
  { token: "rm -rf", reason: "destructive delete" },
  { token: ".env", reason: "secret file access" },
  { token: "push --force", reason: "force push" },
  { token: "push -f", reason: "force push" },
]

const containsToken = (command: string, token: string): boolean =>
  command.toLowerCase().includes(token.toLowerCase())

export const classifyCommand = (command: string): GuardVerdict => {
  for (const entry of DENYLIST) {
    if (containsToken(command, entry.token)) {
      return "deny"
    }
  }
  const allowed = ALLOWLIST.some((prefix) => command.startsWith(prefix))
  return allowed ? "allow" : "escalate"
}
```

`test/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { classifyCommand } from "../src/policy.js"

describe("guard policy", () => {
  it("allows nx and pnpm test commands", () => {
    expect(classifyCommand("nx test @harness/ingest")).toBe("allow")
    expect(classifyCommand("pnpm test")).toBe("allow")
  })

  it("denies rm -rf outside the workspace, .env and force pushes", () => {
    expect(classifyCommand("rm -rf /home")).toBe("deny")
    expect(classifyCommand("cat .env")).toBe("deny")
    expect(classifyCommand("git push --force origin main")).toBe("deny")
  })

  it("escalates unknown commands to the decision model", () => {
    expect(classifyCommand("curl https://example.com")).toBe("escalate")
  })
})
```

- [ ] **Step 4: Write `apps/harness-cli` files.**

`package.json`:

```json
{
  "name": "harness-cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:app"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test",
    "start": "node src/index.ts"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "vitest": "5.0.3"
  }
}
```

`tsconfig.json` (note the different depth — apps are one level shallower than libs):

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
```

`src/index.ts` — command registry; phase 2 wires each command to the harness services (plain Node API on purpose: `@effect/cli` 0.77.2 still peers on effect ^3 and must not be installed):

```ts
const COMMANDS = ["guard", "route", "done", "ingest", "verify", "session", "help"] as const
type Command = (typeof COMMANDS)[number]

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value)

const run = (argv: ReadonlyArray<string>): number => {
  const requested = argv[0] ?? "help"
  if (!isCommand(requested)) {
    console.error(`unknown command: ${requested}`)
    console.error(`usage: harness <${COMMANDS.join("|")}>`)
    return 1
  }
  console.log(`harness ${requested}`)
  return 0
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("index.ts")) {
  process.exit(run(process.argv.slice(2)))
}

export { COMMANDS, run }
export type { Command }
```

`test/index.test.ts` (Node 24 runs `.ts` entry points with native type stripping, so the spawn needs no loader):

```ts
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { COMMANDS, run } from "../src/index.js"

describe("harness cli", () => {
  it("accepts every registered command", () => {
    for (const command of COMMANDS) {
      expect(run([command])).toBe(0)
    }
  })

  it("rejects unknown commands with exit code 1", () => {
    expect(run(["nonsense"])).toBe(1)
  })

  it("prints usage on the help command", () => {
    const usage = execFileSync("node", ["src/index.ts", "help"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    })
    expect(usage).toContain("harness help")
  })
})
```

- [ ] **Step 5: Write `apps/harness-mcp` files.**

`package.json`:

```json
{
  "name": "harness-mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:app"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test",
    "start": "node src/server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.32.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "vitest": "5.0.3"
  }
}
```

`tsconfig.json` and `vitest.config.ts`: byte-for-byte the same as the harness-cli package above (Step 4).

`src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export const createServer = (): McpServer =>
  new McpServer({ name: "harness-mcp", version: "0.0.0" })
```

`test/server.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createServer } from "../src/server.js"

describe("harness-mcp", () => {
  it("constructs an MCP server without registering tools yet", () => {
    expect(createServer()).toBeDefined()
  })
})
```

- [ ] **Step 6: Verify everything together, then commit:**

```bash
pnpm install
pnpm verify:all
```

Expected: `verify` green for all 7 projects (`sample-domain`, `sample-infra`, `ingest`, `decision`, `gates`, `harness-cli`, `harness-mcp`).

```bash
git add -A
git commit -m "feat(harness): ingest/decision/gates seeds + harness-cli/harness-mcp skeletons"
```

---

### Task 7: Knowledge layer — vendored Effect and Alchemy subtrees, editor/agent rules

**Files:**

- Create (via git): `repos/effect/`, `repos/alchemy/` (squashed subtrees)
- Create: `.vscode/settings.json`, `AGENTS.md`, `CLAUDE.md`, `agent-patterns/README.md`, `docs/dependency-pins.md`, `docs/alchemy-llms.txt`, `docs/alchemy-llms-full.txt` (downloaded snapshots)

**Interfaces:**

- Consumes: clean committed tree (Tasks 1–6), network access to github.com and alchemy.run.
- Produces: pinned Effect source at `repos/effect` and pinned Alchemy source at `repos/alchemy` (both read-only), recorded pin SHAs, locally vendored Alchemy doc snapshots the agent reads offline (`docs/alchemy-llms*.txt`), agent authority rules including the Alchemy infra/deploy policy, `docs/dependency-pins.md` with the exact version table from Global Constraints.

- [ ] **Step 1: Vendor Effect main (v4) as a squashed subtree** (large download; keep the exact arguments — mvp.md specifies the same command for future updates via `git subtree pull`):

```bash
git status --short
git subtree add --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash
git rev-parse HEAD
```

Expected: `git status` clean before the subtree add (commit anything pending first); subtree commit created; note the printed SHA — it is the pin.

- [ ] **Step 2: Verify the vendored source:**

```bash
test -f repos/effect/LLMS.md && echo "LLMS.md present"
grep -m1 '"version"' repos/effect/packages/effect/package.json
```

Expected: `LLMS.md present`; version `4.0.0` (or the current main version — record it in `docs/dependency-pins.md` next to the pin SHA).

- [ ] **Step 3: Vendor Alchemy as the second squashed subtree and snapshot its agent docs** (mvp.md "Knowledge layer": second read-only subtree pinned to the installed version; docs go local so lookups are offline, CI-safe and version-aligned):

```bash
git subtree add --prefix=repos/alchemy https://github.com/alchemy-run/alchemy.git main --squash
git rev-parse HEAD
test -d repos/alchemy/packages/alchemy && echo "alchemy package present"
grep -m1 '"version"' repos/alchemy/packages/alchemy/package.json
curl -fsSL https://alchemy.run/llms.txt -o docs/alchemy-llms.txt
curl -fsSL https://alchemy.run/llms-full.txt -o docs/alchemy-llms-full.txt
wc -c docs/alchemy-llms.txt docs/alchemy-llms-full.txt
grep -c "tutorial/part" docs/alchemy-llms.txt
```

Expected: subtree commit created; note the pin SHA; `alchemy package present`; version `2.0.0-beta.80` or newer on main (main may be ahead of the installed pin — record the actual value in `docs/dependency-pins.md` next to the installed `2.0.0-beta.80`; mvp.md's risk table covers keeping them in sync via one Nx target later). Both doc snapshots non-empty and the index lists the tutorial parts. The snapshots pin the docs to the installed version window — record the snapshot date and byte sizes in `docs/dependency-pins.md`, and re-run the two `curl` commands whenever the subtree/pin is refreshed (same Nx target).

- [ ] **Step 4: Confirm tooling ignores `repos/`.** Run:

```bash
pnpm nx show projects
pnpm exec oxlint .
pnpm exec tsc --noEmit -p libs/harness/decision
```

Expected: `nx show projects` lists only the 7 packages (no `effect-*` or `alchemy-*` packages from the subtrees — `nx.json` `ignore` from Task 2 handles this; if any leak, add them to `ignore` and rerun); oxlint exits 0 (`ignorePatterns` covers `repos/**`); typecheck unaffected.

- [ ] **Step 5: Write `.vscode/settings.json`** (editor must use the workspace TS 7 so the patched language service is active; `repos/` stays out of search, watchers and auto-imports — mvp.md "Knowledge layer"):

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "search.exclude": {
    "repos/**": true,
    "**/node_modules": true,
    "dist": true,
    "coverage": true
  },
  "files.watcherExclude": {
    "repos/**": true
  },
  "typescript.preferences.autoImportFileExcludePatterns": ["repos/**"]
}
```

- [ ] **Step 6: Write `AGENTS.md`** (agent-neutral rules; order of authority verbatim from mvp.md, plus the Alchemy infra policy):

```markdown
# AGENTS.md — Effect-TS Engineering Harness

## Order of authority (when learning Effect, follow in this order)

1. `repos/effect/LLMS.md`
2. Source code and tests in `repos/effect`
3. `agent-patterns/*.md`
4. effect-graph and the Nx graph for anything about services and Layers

Google Code Wiki and other generated/prose docs are out — never cite them.

## `repos/` rules

- `repos/effect` and `repos/alchemy` are read-only squashed git subtrees pinned to recorded commits.
- Never edit files under `repos/`, never import from them. App code imports `effect`, `alchemy` and scoped packages like any npm dependency.

## Workflow (one task)

plan (in Effect idioms, `agent-patterns/planning.md` template) → skeleton typechecks →
`harness plan check` → implement → `harness verify` (the ONLY sanctioned verification) → done.

## Planning in Effect idioms

A plan maps each section to an Effect building block: Schema at boundaries, tagged errors,
Context.Service capabilities, Layer dependency graph, `Effect<A, E, R>` use-case signatures,
Scope for resources, Schedule for retry/concurrency, Config + `Effect.fn("name")` spans, test Layers.
Plan as code: write the skeleton first (schemas, errors, service interfaces, signatures with stub
bodies) — it must pass typecheck before implementation starts.

## Code style (from `repos/effect/LLMS.md`)

Prefer `Effect.gen` inline; use `Effect.fn("name")` for reusable traced functions and
`Effect.fnUntraced` otherwise; avoid wrappers that only return `Effect.gen`; `return` instead of
yielding-and-assigning an error.

## Nx taxonomy

- `type:contract` — shared Schemas, `HttpApi`, `RpcGroup`, API errors; imports `effect` only
- `type:domain` — use cases and pure logic, no I/O; imports `contract`; must not depend on `type:infra`
- `type:service` — service interfaces, including repositories
- `type:infra` — live Layer implementations, Drizzle repositories and handlers, Alchemy resources
- `type:app` — composes Layers and runs the runtime; the `web` app may import `contract` and UI libraries only

## Data layer rules (Drizzle on D1 / Durable Objects)

- `drizzle-orm` and table schemas (`sqliteTable`) are imported only in `type:infra`; repositories decode rows into contract Schemas, so Drizzle types never reach the domain or the frontend.
- Migrations are generated by hand with `drizzle-kit generate` and committed; they are never generated at deploy. A migration containing `DROP` or a table rebuild escalates to the human.

## Infrastructure (Alchemy)

- The sample app (`apps/sample`) declares cloud infrastructure with Alchemy v2; its source is pinned read-only in `repos/alchemy`.
- Resources and bindings may be created only in `type:infra` libraries and the app's `alchemy.run.ts`; a `type:domain` library never creates or binds a cloud resource.
- Never run `alchemy deploy` or `alchemy destroy` — they are human-only and the guard asks before them. Every deploy is confirmed individually, never batched.
- Cloudflare credentials live in Alchemy profiles: `alchemy profile edit --add Cloudflare` saves them to `~/.alchemy/profiles.json`. Never export `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN`, never put them in `.env`.
- For Alchemy lookups read the pinned source in `repos/alchemy` and the vendored doc snapshots `docs/alchemy-llms.txt` (index) and `docs/alchemy-llms-full.txt` (per-resource reference — grep it locally, do not fetch). The live https://alchemy.run/llms.txt documents the newest release and drifts from our pin; use it only to refresh the snapshots. Tutorial: https://alchemy.run/cloudflare/tutorial/part-1 through part-5.

## Definition of done

`nx affected -t verify` green (typecheck + lint + test per project). Deterministic gates always
win; the decision model never overrides them.
```

- [ ] **Step 7: Write `CLAUDE.md`:**

```markdown
# CLAUDE.md

Read and follow [AGENTS.md](./AGENTS.md) — it is the single source of agent rules in this repo.
```

- [ ] **Step 8: Write `agent-patterns/README.md`** (the pattern files are generated from the vendored sources in phase 1 and human-reviewed before use):

```markdown
# agent-patterns

Reviewed Effect and Alchemy pattern files, generated from the pinned sources in `repos/effect`
and `repos/alchemy` — never from external docs. Planned set (mvp.md "Knowledge layer"):

- services-and-layers.md
- errors.md
- schema.md
- resources-scope.md
- concurrency.md
- schedule.md
- testing.md
- planning.md (the plan template; maps plan sections to Effect building blocks)
- alchemy-infra.md (Alchemy resources and bindings inside service Layers; generated from repos/alchemy)
- d1-repository.md (D1 table + Drizzle repository + migration)
- durable-object-state.md (Durable Object with its own SQLite schema + migration)
- httpapi.md (public `HttpApi` endpoints with declared error Schemas)
- rpc.md (internal `RpcGroup` procedures)
- atom.md (`AtomHttpApi` atoms over the public API)

Status: not yet generated (phase 1). Until then, authority order in `AGENTS.md` applies.
```

- [ ] **Step 9: Write `docs/dependency-pins.md`** with three sections: (a) the exact version table from this plan's Global Constraints (including `alchemy 2.0.0-beta.80`), (b) the pin SHAs and vendored versions — `repos/effect` SHA from Step 1 plus the effect package version from Step 2, and `repos/alchemy` SHA from Step 3 plus the alchemy package version read there, (c) the Alchemy doc snapshots — `docs/alchemy-llms.txt` and `docs/alchemy-llms-full.txt` with the snapshot date and byte sizes from Step 3. Commit:

```bash
git add -A
git commit -m "docs(knowledge): vendored effect + alchemy subtrees, alchemy llms snapshots, editor/agent rules, dependency pins"
```

---

### Task 8: Alchemy sample app — `apps/sample` with a single R2 Bucket

**Files:**

- Create: `apps/sample/package.json`, `apps/sample/tsconfig.json`, `apps/sample/alchemy.run.ts`

**Interfaces:**

- Consumes: workspace from Task 1 (the `apps/*` glob picks the package up), pinned alchemy from Global Constraints, `repos/alchemy` source (Task 7) as the API authority.
- Produces: package `sample-app` (Nx tag `type:app`) with scripts `typecheck` / `lint` / `verify` / `dev` / `deploy`; a default-exported Alchemy Stack with one `Cloudflare.R2.Bucket`. Phase 2 adds the service Layers that own resources/bindings and the `test:emulated` suite.

- [ ] **Step 1: Write `apps/sample/package.json`.** `verify` has no `test` leg yet — the emulated Alchemy `Test.make({ dev: true })` suite joins it in phase 2 (mvp.md: `test:emulated` part of `verify`). The `deploy` script exists for humans/CI only; Task 9 makes the guard ask before an agent runs it:

```json
{
  "name": "sample-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:app"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "verify": "pnpm run typecheck && pnpm run lint",
    "dev": "alchemy dev",
    "deploy": "alchemy deploy"
  },
  "dependencies": {
    "alchemy": "2.0.0-beta.80",
    "effect": "4.0.0",
    "@effect/platform-node": "4.0.0"
  }
}
```

(@effect/platform-node is the Node leg of alchemy's getting-started install set; `@effect/platform-bun` is Bun-only and deliberately omitted — this repo runs on Node and pnpm.)

- [ ] **Step 2: Write `apps/sample/tsconfig.json`** (the stack file lives at the package root, so it is included explicitly):

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "alchemy.run.ts"]
}
```

- [ ] **Step 3: Write `apps/sample/alchemy.run.ts`** — the getting-started/tutorial part-1 shape, followed exactly: one Stack, one R2 Bucket, no Worker. State stays on Cloudflare (`Cloudflare.state()`); for purely local runs it can be swapped to `State.localState()` from `alchemy/State` (disk-backed under `.alchemy/`, gitignored since Task 1):

```ts
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

export default Alchemy.Stack(
  "sample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Bucket")

    return {
      bucketName: bucket.bucketName,
    }
  }),
)
```

- [ ] **Step 4: Install, then prove the stack typechecks (mvp.md infra acceptance box 1, first half):**

```bash
pnpm install
pnpm nx run sample-app:typecheck
```

Expected: PASS. (alchemy's peers are all optional, so no extra packages are pulled.) If `Alchemy.Stack` / `Cloudflare.R2.Bucket` shapes differ in the pinned beta, correct against `repos/alchemy/packages/alchemy/src` per the AGENTS.md authority order — keep the single-Stack single-Bucket structure.

- [ ] **Step 5: Prove resource typing blocks at the gate.** Temporarily rename the returned property to `bucket.bucketNam` (typo) in `alchemy.run.ts` and rerun:

```bash
pnpm nx run sample-app:typecheck
```

Expected: **FAIL** with a "Property 'bucketNam' does not exist" style error — resources are typed, not `any`. Revert the typo and confirm PASS. (The stronger phase-2 proof — removing a binding from a service Layer fails typecheck — needs the real sample feature and stays in phase 2.)

- [ ] **Step 6: Commit.** Do **not** run `alchemy deploy` in this task: provisioning the Bucket (first `pnpm alchemy deploy`, connecting via `alchemy profile edit --add Cloudflare` with OAuth or an API token) is a human step, confirmed individually — run it only if the Bucket should be live now; nothing in this plan requires it.

```bash
git add -A
git commit -m "feat(sample-app): alchemy v2 stack with single R2 bucket (typecheck-gated, nothing deployed)"
```

---

### Task 9: Guard policy — `ask` verdict for `alchemy deploy` / `destroy` / profile commands

**Files:**

- Modify: `libs/harness/gates/src/policy.ts`, `libs/harness/gates/test/policy.test.ts`

**Interfaces:**

- Consumes: `@harness/gates` from Task 6.
- Produces: `classifyCommand(cmd: string): "allow" | "deny" | "ask" | "escalate"` — new `ask` verdict for `alchemy deploy` / `alchemy destroy` / `alchemy profile` (mvp.md infra acceptance: "The safety guard asks a human before any agent-run `alchemy deploy` or `alchemy destroy`"); exported `ASKLIST` seed. Local `alchemy dev` stays `escalate` (goes to the decision model like any unknown command).

- [ ] **Step 1: Write the failing tests first.** Replace `libs/harness/gates/test/policy.test.ts` with:

```ts
import { describe, expect, it } from "vitest"
import { classifyCommand } from "../src/policy.js"

describe("guard policy", () => {
  it("allows nx and pnpm test commands", () => {
    expect(classifyCommand("nx test @harness/ingest")).toBe("allow")
    expect(classifyCommand("pnpm test")).toBe("allow")
  })

  it("denies rm -rf outside the workspace, .env and force pushes", () => {
    expect(classifyCommand("rm -rf /home")).toBe("deny")
    expect(classifyCommand("cat .env")).toBe("deny")
    expect(classifyCommand("git push --force origin main")).toBe("deny")
  })

  it("asks a human before alchemy deploys, destroys and profile changes", () => {
    expect(classifyCommand("alchemy deploy")).toBe("ask")
    expect(classifyCommand("pnpm alchemy deploy")).toBe("ask")
    expect(classifyCommand("alchemy destroy --stage preview")).toBe("ask")
    expect(classifyCommand("alchemy profile edit --add Cloudflare")).toBe("ask")
  })

  it("still escalates local alchemy dev and unknown commands to the decision model", () => {
    expect(classifyCommand("alchemy dev")).toBe("escalate")
    expect(classifyCommand("curl https://example.com")).toBe("escalate")
  })
})
```

Run: `pnpm nx run @harness/gates:test`
Expected: **FAIL** — `classifyCommand("alchemy deploy")` returns `"escalate"` today.

- [ ] **Step 2: Implement the `ask` verdict.** Replace `libs/harness/gates/src/policy.ts` with:

```ts
/** Deterministic guard policy. `classifyCommand` never calls the decision model:
 * "escalate" means "deterministic rules left this open" (mvp.md, safety guard row);
 * "ask" means "always confirm with the human first" (alchemy deploy/destroy/profile,
 * matching Alchemy's own advice to confirm every deploy). */

export type GuardVerdict = "allow" | "deny" | "ask" | "escalate"

export const ALLOWLIST: ReadonlyArray<string> = ["nx ", "pnpm test", "pnpm nx ", "pnpm verify"]

export const DENYLIST: ReadonlyArray<{ readonly token: string; readonly reason: string }> = [
  { token: "rm -rf", reason: "destructive delete" },
  { token: ".env", reason: "secret file access" },
  { token: "push --force", reason: "force push" },
  { token: "push -f", reason: "force push" },
]

/** Human confirmation required, never auto-approved (mvp.md "Infrastructure as Effect",
 * safety guard row). Substring match, so `pnpm alchemy deploy` is covered too. */
export const ASKLIST: ReadonlyArray<string> = [
  "alchemy deploy",
  "alchemy destroy",
  "alchemy profile",
]

const containsToken = (command: string, token: string): boolean =>
  command.toLowerCase().includes(token.toLowerCase())

export const classifyCommand = (command: string): GuardVerdict => {
  for (const entry of DENYLIST) {
    if (containsToken(command, entry.token)) {
      return "deny"
    }
  }
  if (ASKLIST.some((token) => containsToken(command, token))) {
    return "ask"
  }
  const allowed = ALLOWLIST.some((prefix) => command.startsWith(prefix))
  return allowed ? "allow" : "escalate"
}
```

- [ ] **Step 3: Run the test to verify it passes, then the composite gate:**

```bash
pnpm nx run @harness/gates:test
pnpm nx run @harness/gates:verify
```

Expected: both PASS (deny wins over ask, so `alchemy deploy && rm -rf /` still denies).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(gates): ask verdict for alchemy deploy/destroy/profile commands"
```

---

### Task 10: `@harness/sample-contract` — the `type:contract` tag and its boundary chain

**Files:**

- Create: `libs/sample/contract/package.json`, `libs/sample/contract/tsconfig.json`, `libs/sample/contract/vitest.config.ts`, `libs/sample/contract/src/index.ts`, `libs/sample/contract/test/index.test.ts`
- Modify: `libs/sample/domain/package.json`, `libs/sample/domain/src/index.ts`

**Interfaces:**

- Consumes: boundaries config from Task 5 (`type:contract` constraints), workspace from Task 1.
- Produces: package `@harness/sample-contract` (tag `type:contract`, dependency `effect` only) exporting `GreetInput` (Schema + type). The domain lib imports it, proving the `contract → domain` chain. Phase 2 adds the public `HttpApi`, `RpcGroup`s and API errors to this package.

- [ ] **Step 1: Write `libs/sample/contract/package.json`:**

```json
{
  "name": "@harness/sample-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:contract"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test"
  },
  "dependencies": {
    "effect": "4.0.0"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "vitest": "5.0.3"
  }
}
```

`tsconfig.json` and `vitest.config.ts`: byte-for-byte the same as the ingest package (Task 6 Step 1).

- [ ] **Step 2: Move the shared Schema into the contract.** Write `libs/sample/contract/src/index.ts`:

```ts
import { Schema } from "effect"

export const GreetInput = Schema.Struct({ name: Schema.String })
export type GreetInput = typeof GreetInput.Type
```

`libs/sample/contract/test/index.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { GreetInput } from "../src/index.js"

describe("contract", () => {
  it("decodes valid input", () => {
    const decoded = Schema.decodeUnknownSync(GreetInput)({ name: "Roman" })
    expect(decoded.name).toBe("Roman")
  })
})
```

- [ ] **Step 3: Point the domain at the contract.** In `libs/sample/domain/package.json` add to `dependencies`:

```json
"@harness/sample-contract": "workspace:*"
```

and rewrite `libs/sample/domain/src/index.ts` to import the Schema from the contract (no local copy):

```ts
import { Effect } from "effect"
import { GreetInput } from "@harness/sample-contract"

export const greet = Effect.fn("Sample.greet")(function* (input: GreetInput) {
  return `Hello, ${input.name}!`
})
```

- [ ] **Step 4: Verify the chain, then prove the contract boundary.**

```bash
pnpm install
pnpm nx run-many -t verify -p @harness/sample-contract @harness/sample-domain
```

Expected: both PASS — `type:domain` importing `type:contract` is allowed by the Task 5 constraints. Then prove contracts stay leaf-only: temporarily add `"@harness/sample-domain": "workspace:*"` to the contract's dependencies and `import { greet } from "@harness/sample-domain"` to its `src/index.ts`, run `pnpm nx reset && pnpm nx run-many -t lint` — expected **FAIL** with an `enforce-module-boundaries` violation (`type:contract` depending on `type:domain`). Revert both edits and confirm green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sample-contract): type:contract lib, domain imports contract Schema"
```

---

### Task 11: Drizzle on D1 in `@harness/sample-infra` + the migration drift gate

**Files:**

- Modify: `libs/sample/infra/package.json` (dependencies, scripts)
- Create: `libs/sample/infra/src/db/schema.ts`, `libs/sample/infra/drizzle.config.ts`, `libs/sample/infra/scripts/check-migrations.mjs`, `libs/sample/infra/migrations/` (generated, committed)

**Interfaces:**

- Consumes: `@harness/sample-infra` (Task 5), the `drizzle-orm` import ban and its `**/infra/**` escape (Task 4).
- Produces: the `photos` D1 table schema (`sqliteTable`, infra-only per mvp.md); committed baseline migration; script `migration:check` wired into sample-infra's `verify` with exit codes `0` in-sync / `1` schema changed without a committed migration / `2` destructive drift (DROP, table rebuild) escalates to the human. The actual `Drizzle.D1` queries (driver `drizzle-orm/effect-d1` on `@effect/sql-d1`) and the Durable Object store arrive in phase 2 with the real repository work.

- [ ] **Step 1: Update `libs/sample/infra/package.json`** — add dependencies, the gate script, and extend `verify`:

```json
{
  "name": "@harness/sample-infra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "nx": {
    "tags": ["type:infra"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint .",
    "test": "vitest run",
    "migration:check": "node scripts/check-migrations.mjs",
    "migration:generate": "drizzle-kit generate",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run migration:check"
  },
  "dependencies": {
    "effect": "4.0.0",
    "drizzle-orm": "0.45.3"
  },
  "devDependencies": {
    "@effect/vitest": "4.0.0",
    "drizzle-kit": "0.31.11",
    "vitest": "5.0.3"
  }
}
```

- [ ] **Step 2: Write the table schema and the drizzle-kit config.**

`libs/sample/infra/src/db/schema.ts` (table schemas live only here — Task 4's ban keeps them out of every other package):

```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const photos = sqliteTable("photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

`libs/sample/infra/drizzle.config.ts` (generation only — never run at deploy; the config file sits outside `src/`, so the import bans do not apply to tooling):

```ts
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
})
```

- [ ] **Step 3: Write the drift gate** `libs/sample/infra/scripts/check-migrations.mjs` (a build script outside `src/` — plain Node is deliberate here; it wraps a CLI, it is not Effect application code):

```js
// Migration drift gate (mvp.md "Migration gates in verify").
// Copies the committed migrations snapshot to a temp folder and runs
// `drizzle-kit generate` against it:
//   no new .sql files                        -> exit 0 (schema and migrations in sync)
//   new .sql files without destructive SQL   -> exit 1 (schema changed without a committed migration)
//   new .sql files with DROP / table rebuild -> exit 2 (ESCALATE to the human)
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const destructive = /\bDROP\s+(TABLE|COLUMN|INDEX|TRIGGER|VIEW)\b/i

const listSql = async (dir) => {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".sql"))
  } catch {
    return []
  }
}

const temp = await mkdtemp(join(tmpdir(), "drizzle-drift-"))
try {
  await cp("migrations", join(temp, "migrations"), { recursive: true })
} catch {
  console.error("migration check: FAIL — no committed baseline migration in migrations/")
  process.exit(1)
}

try {
  const outDir = join(temp, "migrations")
  const before = await listSql(outDir)

  execFileSync(
    "pnpm",
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect",
      "sqlite",
      "--schema",
      "./src/db/schema.ts",
      "--out",
      outDir,
      "--name",
      "drift",
    ],
    { stdio: "pipe" },
  )

  const newFiles = (await listSql(outDir)).filter((file) => !before.includes(file))
  if (newFiles.length === 0) {
    console.log("migration check: schema and committed migrations are in sync")
    process.exit(0)
  }
  for (const file of newFiles) {
    const sql = await readFile(join(outDir, file), "utf8")
    if (destructive.test(sql)) {
      console.error(
        `migration check: ESCALATE — destructive drift requires a human decision (${file}):\n${sql}`,
      )
      process.exit(2)
    }
  }
  console.error(
    `migration check: FAIL — schema changed without a committed migration:\n${newFiles.join("\n")}`,
  )
  process.exit(1)
} finally {
  await rm(temp, { recursive: true, force: true })
}
```

- [ ] **Step 4: Generate the baseline migration and confirm the gate is green:**

```bash
pnpm install
cd libs/sample/infra && pnpm exec drizzle-kit generate && cd ../..
pnpm nx run sample-infra:verify
```

Expected: `drizzle-kit generate` writes `migrations/0000_*.sql` plus `migrations/meta/` (commit both — mvp.md: migrations are committed, never generated at deploy); `verify` PASS including `migration:check` (no drift). If drizzle-kit prompts for input, the change was ambiguous — for this seed it should not; regenerate with explicit `--name`.

- [ ] **Step 5: Prove the drift gate.** Temporarily add a column to `libs/sample/infra/src/db/schema.ts` (e.g. `size: text("size")` after `name`) without generating:

```bash
pnpm nx run sample-infra:verify
echo "exit code: $?"
```

Expected: **FAIL** with exit code 1 — "schema changed without a committed migration". Then make it destructive instead (temporarily remove the `name` column — SQLite drops columns via table rebuild, so the generated SQL contains `DROP TABLE`):

```bash
pnpm nx run sample-infra:migration:check
echo "exit code: $?"
```

Expected: **FAIL** with exit code 2 and `ESCALATE` in the output. Revert the schema to the committed state and confirm `pnpm nx run sample-infra:verify` is green again.

- [ ] **Step 6: Prove the drizzle import ban outside infra (mvp.md Application-stack acceptance).** Temporarily add `import { integer } from "drizzle-orm"` to `libs/sample/domain/src/index.ts` and `"drizzle-orm": "0.45.3"` to the domain's dependencies, run `pnpm nx reset && pnpm nx run-many -t lint` — expected **FAIL** with `no-restricted-imports` for `drizzle-orm`. Revert both edits and confirm green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(sample-infra): drizzle d1 schema + committed migration + drift gate with destructive escalation"
```

---

### Task 12: CI workflow, README, fresh-clone rehearsal

**Files:**

- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**

- Consumes: everything from Tasks 1–11.
- Produces: CI running `nx affected -t verify` (no agent, no Ollama, no Cloudflare, no deploys — mvp.md "Flows outside the task loop" and Alchemy non-goals); a README that gets a fresh clone to green with only pnpm, Docker and Ollama installed (Cloudflare account only when a human later runs `alchemy dev`/`deploy`).

- [ ] **Step 1: Write `.github/workflows/ci.yml`:**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - name: Verify affected projects
        run: pnpm exec nx affected -t verify --base=origin/main
```

- [ ] **Step 2: Write `README.md`** with: one-paragraph intent (from mvp.md), prerequisites (pnpm 12.9.1 via corepack, Node ≥ 24, Docker for code-graph-rag in later phases, Ollama + `clef-flash` for phase 2, Cloudflare account **only** when a human runs `alchemy dev`/`deploy` — `alchemy profile edit --add Cloudflare` stores credentials in `~/.alchemy/profiles.json`, no environment variables; `oasdiff` binary for the phase-2 breaking-change gate), setup (`corepack enable && pnpm install` — the `prepare` script patches TypeScript and oxlint), the gate table (typecheck / lint / test / `migration:check` per project / `nx affected -t verify` as definition of done), the Alchemy note (`apps/sample/alchemy.run.ts` typechecks in every verify; `alchemy deploy`/`destroy` are human-only and guard-guarded; Alchemy docs are vendored locally in `docs/alchemy-llms*.txt`), the Drizzle note (schema changes require a committed migration — `verify` fails on drift; `DROP` escalates), repo layout (same tree as mvp.md's Architecture section plus `apps/sample`), and a pointer to `AGENTS.md` and `docs/mvp.md`.

- [ ] **Step 3: Fresh-clone rehearsal (mvp.md acceptance: works on a fresh clone):**

```bash
rm -rf node_modules
pnpm install
pnpm verify:all
```

Expected: `pnpm install` runs the `prepare` patch cleanly (TypeScript + oxlint patched); `verify:all` green for all 9 projects (`sample-contract`, `sample-domain`, `sample-infra`, `ingest`, `decision`, `gates`, `harness-cli`, `harness-mcp`, `sample-app` — the last one typecheck + lint only until the phase-2 emulated tests). (Uses `verify:all` rather than `verify` because on `main` with no diff `nx affected` has nothing to select — CI supplies `--base=origin/main`.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci: affected verify gate + README"
```

---

## Out of scope (deliberately deferred, per docs/mvp.md phases)

- **Phase 1:** `Effect.fn` name index, recording tracer Layer, trace JSONL converter, `test:trace` / `graph:ingest` Nx targets, pattern-file generation (including `agent-patterns/alchemy-infra.md` and the new `d1-repository` / `durable-object-state` / `httpapi` / `rpc` / `atom` files), the one Nx target that refreshes both subtrees **and re-snapshots `docs/alchemy-llms*.txt`** (flagging pattern files for review), code-graph-rag integration (Docker/Memgraph) including the spike on whether its `endpoints` / `endpoint_callers` tools recognise Effect routes.
- **Phase 2:** real `guard`/`route`/`done`/`verify`/`ingest` implementations in the CLI, MCP tools in `harness-mcp`, Ollama smoke tests, Claude Code adapter (`hooks.json`, `.mcp.json`, skill). On the application-stack side: `HttpApi` and `RpcGroup` in the contract (plus the `contract:openapi` snapshot and the `oasdiff breaking` gate with ERR-escalate/WARN-note semantics), the basic generators (`service`, `use-case`, `contract`, `repository`, `endpoint`, `rpc`), the D1 repository and Durable Object store via `Drizzle.D1` / `Drizzle.DurableObject` (installs `@effect/sql-d1` 4.0.0, `@effect/sql-sqlite-do` 4.0.0; emulated tests apply migrations to both stores), the web app (Vite 8.3.2 + React 19.3.0 + `@effect/atom-react` 4.0.0, `AtomHttpApi` atoms) together with its `scope:web` boundary constraint, the idiom-router categories `d1-repository` / `durable-object-state` / `httpapi` / `rpc` / `atom`, and `HttpApiTest` / `RpcTest` in the test kit. On the Alchemy side: service Layers that own resources and bindings (the Photos pattern from mvp.md, including the "removing a binding from a Layer fails typecheck" proof), the `Test.make({ dev: true })` emulated suite wired as `test:emulated` into `verify`, `alchemy dev` local-dev flows, and the OpenTelemetry exporter for workerd spans (or the documented gap).
- **Phase 3:** `libs/harness/graph` (R/E manifest, `effect-graph:check` with the infra policy — a `type:domain` lib creating or binding a cloud resource, and a D1 / Durable Object binding outside infra), type-aware extractor (ts-morph 28.0.0).
- **Post-MVP (mvp.md non-goals):** live stages, per-PR preview deploys from CI, production monitoring via the `Observability` Layer, Postgres via Hyperdrive, Kysely, browser end-to-end tests.
- **Deferred dependencies** (installed in their phase): `@effect/sql-d1` 4.0.0, `@effect/sql-sqlite-do` 4.0.0, `@effect/atom-react` 4.0.0, `react` 19.3.0, `vite` 8.3.2 (phase 2), `ts-morph` 28.0.0 (phase 3), `@effect/opentelemetry` 4.0.0 (when OTel export is needed); `oasdiff` v1.33.0 as a binary prerequisite when the breaking-change gate is wired.
