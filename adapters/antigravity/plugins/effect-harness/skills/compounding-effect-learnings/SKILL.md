---
name: compounding-effect-learnings
description: Use when completing a task that encountered route misses, repeated verify failures, review gate blind spots, or new Effect v4 / Alchemy v2 patterns, or when running harness learn to promote friction into deterministic gates and pattern recipes.
---

# Compounding Effect Learnings (Zero-Context-Bloat Loop)

## Overview

Turn task friction recorded in `.harness/friction-log.jsonl` and review gate blind spots into permanent, zero-context-bloat harness assets across our 5-tier hexagonal harness packages (`@harness/contract`, `@harness/service`, `@harness/gates`, `@harness/graph`, `@harness/decision`, `@harness/infra`) instead of dumping prose into `AGENTS.md`.

**Violating the letter of the rules is violating the spirit of the rules.**

## The 5 Promotion Targets (Graduation Pyramid)

1. **`agent-pattern` (`route_miss`):** Create or update `agent-patterns/<block>.md` (50–80 lines, concrete Effect v4 / Alchemy v2 code) and register `<block>` in `IDIOM_BLOCKS` & `IdiomRouterV1` in `libs/harness/decision/src/idiom-router.ts` (up to 26 options total).
2. **`triage-rule` (`verify_failure`):** For mechanical/compiler/test errors, add `{ pattern, result: { kind, hint } }` to `DETERMINISTIC_TRIAGE_RULES` in `libs/harness/decision/src/triage-decision.ts` for `0 ms` instant feedback.
3. **`guard-allowlist` (`guard_escalation`):** For recurring safe CLI commands, add prefix to `ALLOWLIST` in `libs/harness/gates/src/policy.ts`.
4. **`ast-graph-gate` (architectural/syntax/hexagonal anti-pattern):** Promote recurring violations across the 5-tier hexagonal harness architecture:
   - Rule IDs & discriminated report schemas in `@harness/contract` (`libs/harness/contract/src/**` — `type:contract`, `0` workspace deps).
   - Pure `R = never` AST/tier/GC gate deciders in `@harness/gates` (`libs/harness/gates/src/**` — `HarnessTierTopology.decide`, `SelfDogfooding.decide`, `GraphGc.decide`, `AstGateCache.decide`) or `@harness/graph` (`libs/harness/graph/src/policy-check.ts`).
   - Synchronous ESTree lint rules in `tools/oxlint/syntax-bans.js`.
   - Whenever modifying gate files, write unit tests for adversarial evasion vectors (shell wrappers/subshells, multi-aggregate files, self-comparisons, `satisfies`/parenthesized casts, mixed causes) and run `effect-adversarial-reviewer` against the gate implementation.
5. **`adr` (durable architectural decision / trade-off):** When a task settles a durable architectural trade-off or rejected alternative (passing the Counterfactual Rule: _"would a future agent repeat this mistake or re-litigate this design without knowing why?"_), create an ADR in `libs/<scope>/docs/adr/NNNN-<slug>.md` (with scoped `id: <scope>:ADR-NNNN`, or in root `docs/adr/` for cross-monorepo decisions) with machine-verifiable YAML frontmatter (`id`, `title`, `status: accepted`, `date`, `enforced_by`, `spans`, `services`, `errors`) with `enforced_by` pointing directly to the enforcing deterministic gate, AST rule, or pattern doc.

## Step-by-Step Recipe (Stamp-Safe Order)

> [!IMPORTANT]
> **Stamp-Safe Ordering (`.harness/verify-stamp.json`):** Follow the canonical stamp-safe ordering rule in [resolving-effect-review-feedback Phase 5](../resolving-effect-review-feedback/SKILL.md#phase-5--gate-promotion-metric-sync--stamp-safe-deterministic-gates-orchestrator-only) (`computeWorkspaceTreeHash` ignores `.git/` and `.harness/`, so `learn --clear` does not affect the stamp, whereas editing any tracked file in `agent-patterns/*.md`, `libs/harness/**`, `tools/oxlint/**`, or `docs/**` _after_ `harness verify` invalidates `.harness/verify-stamp.json`). Always finish all tracked file promotions and `wc -l` doc syncs **before** running the terminal `gc --strict` $\rightarrow$ `ontology check --strict` $\rightarrow$ `mutate --strict` $\rightarrow$ `verify` $\rightarrow$ `done` sequence.

1. **Inspect Friction Clusters:** Run `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn` to inspect grouped `.harness/friction-log.jsonl` clusters and `LearnProposalV1` (`clef-flash`) recommendations.
2. **Apply Approved Promotion & Clear Friction Log:** Present the actionable proposals (or apply gate blind-spot promotions during review resolution) across the 5 targets (`agent-pattern`, `triage-rule`, `guard-allowlist`, `ast-graph-gate`, or `adr`). Maintain strict 5-tier hexagonal hygiene (`HarnessTierTopology.decide` & `SelfDogfooding.decide`: explicit named exports on all `index.ts` barrels per `facade-star-reexport`, zero `node:*` or `process.env` in `type:core`). Refresh any affected `wc -l` / LOC tables in `docs/**`, and clear the friction log:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts learn --clear
   ```
3. **Run Stamp-Safe Terminal Verification Sequence:**
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ontology check --strict
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts mutate --strict
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts verify
   CI=true node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done
   ```

## Rationalization Table

| Excuse                                                             | Reality                                                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "I'll append a rule into `AGENTS.md`"                              | Prose in `AGENTS.md` burns prompt tokens on every turn. An `agent-pattern` or deterministic gate costs 0 extra prompt tokens until triggered.                               |
| "A single verify error doesn't need a triage rule"                 | Repeated compiler/test errors waste developer turns. Adding a regex to `DETERMINISTIC_TRIAGE_RULES` gives future runs instant 0ms hints.                                    |
| "I'll edit a gate or `agent-patterns/*.md` after `harness verify`" | Any edit to a tracked file after `harness verify` invalidates `.harness/verify-stamp.json` (`treeHash`). Always finish promotions and `wc -l` syncs before `verify`/`done`. |
| "I can clear friction logs without promoting"                      | Clearing unaddressed friction discards hard-won engineering learnings. Always promote recurring friction before `--clear`.                                                  |
| "I don't need an ADR for a subtle architectural trade-off"         | Code shows _what_ was built, not _why_ alternatives were rejected. Without an ADR, future agents will re-introduce rejected patterns.                                       |

## Red Flags — STOP

- Dumping prose reminders or warnings into `AGENTS.md`
- Editing any tracked workspace file after `harness verify` / `harness done` without re-running `gc --strict` $\rightarrow$ `ontology check --strict` $\rightarrow$ `mutate --strict` $\rightarrow$ `verify` $\rightarrow$ `done`
- Introducing `export *` in `index.ts` barrels (`facade-star-reexport`), `node:*` imports (`no-node-builtins-outside-infra`), or module-scope mutable caches (`no-global-mutable-cache`) when adding gates to `@harness/gates` / `@harness/graph` / `@harness/decision` (`type:core`)
- Hardcoding complex multi-step instructions where an AST rule or compiler check is possible
- Clearing `.harness/friction-log.jsonl` before applying or declining actionable promotions
- Settling a non-obvious design trade-off without recording an ADR in `libs/<scope>/docs/adr/` (or `docs/adr/`)
