# Review Routing Predicates & 7-Specialist Lens Checklists

This reference defines the deterministic routing predicates returned by `harness_review_route` (`libs/harness/contract/src/review-routing.ts`, `libs/harness/decision/src/review-router-decision.ts`) and the surface checklists for all 7 specialist reviewers.

## 1. Observable Depth Gate (`skip | lite | focused | full`)

`harness_review_route` evaluates touched file paths, Nx `type:*` / `scope:*` tags, changed line count, and optional `clef-flash` (`ReviewRouterV1`) escalation (monotonic upward-only: the model can escalate `lite -> focused -> full` or add lenses, never downgrade deterministic selections):

| Depth | Observable Trigger Predicate | Orchestration Mode |
| --- | --- | --- |
| `skip` | `changedFiles.length === 0`, or zero behavioral/surface flags with `changedLineCount < 40` | Emit Section 1 receipt (`depth: skip`) and conclude. |
| `lite` | Single non-`type:core`, non-`type:domain` file with `changedLineCount < 40` (`1` selection, no stateful/decider or migration/infra-binding signal) | Single-pass read-only review using the primary matching lens; no subagent fan-out. |
| `focused` | Multi-file diff or single-surface signal (`scope:web`, `type:contract`, `type:infra`, `type:service`, or `adapters/`) | Dispatch only the signal-routed specialist subagent(s) (`invoke_subagent` / `swarm`). |
| `full` | Any `type:core` or `type:domain` change, decider/event-sourcing change, multi-tier diff, or `changedLineCount >= 180` | Dispatch all routed specialists in parallel, including mandatory dual-review (`effect-ears-test-reviewer` + `effect-adversarial-reviewer`) for `type:core`/`type:domain`. |

## 2. 7-Specialist Signal-Routing & Lens Checklists

| Specialist Reviewer | Triggering Signals (Paths / Tiers / Content) | Core Hunting Checklist |
| --- | --- | --- |
| **`effect-ears-test-reviewer`** | `type:core`, `type:domain`, `*.test.ts`, `docs/specs/**`, `docs/adr/**` | EARS 1:1 behavioral coverage, `Effect.flip`/`Cause.hasDies` negative tests, `it.effect.prop` decider boundaries, terminal-state preservation, span budgets (`SpanBudget.decide`), `8-Point Anti-Rubber-Stamp` Audit, `type:infra` guard-deletion falsification. |
| **`effect-adversarial-reviewer`** | `type:core`, `type:domain`, deciders, reducers, `libs/harness/**` | Inter-step crash sequences, duplicate/replay idempotency gates inside SQLite transactions, optimistic concurrency races, terminal state replay, SQLite fractional affinity, skeleton `E`-channel completeness. |
| **`effect-security-reviewer`** | `type:contract`, `HttpApi`, `Rpc`, auth/session, `Redacted`, R2/DO keys | IDOR / missing `actorId`/`tenantId` ownership checks, `Redacted.value` telemetry/error leaks, unbounded input schemas (`maxLength`, `maxItems`, `Finite`), client-supplied identity trust, indirect SQL/R2/DO ID injection. |
| **`effect-reliability-reviewer`** | `type:infra`, DO SQLite, D1, Queues, Alarms, `Schedule`, `Scope` | Async effects/`Schema.decode` inside `withTransaction`, in-memory `Ref` mutation before commit, unjittered/uncapped `Schedule.exponential`, missing external `Effect.timeout`, silent error drops in queues/alarms, missing W3C `traceparent`, `SqliteMigrator` table isolation. |
| **`effect-web-reviewer`** | `scope:web`, `apps/sample-web/**`, `*.tsx`, `AtomHttpApi` | Raw `fetch`/ad-hoc `useEffect` loops bypassing `AtomHttpApi.make`, double-submit `useAtomSend` without pending/disabled guard, stale closures on parameterized query atoms, leaked listeners/timers, partial `Result`/`Option` `_tag` rendering instead of `match(...)...exhaustive()`, unvalidated `<Brand>.make(rawInput)` on forms/URLs. |
| **`effect-migration-contract-reviewer`** | `migrations/*.sql`, `SqliteMigrator`, `type:contract` (`HttpApi`/`RpcGroup`/events), `alchemy.run.ts` | Single-step `RENAME COLUMN`/retype breaking deploy skew, editing shipped migrations, shared `SqliteMigrator` table collisions, unindexed `WHERE`/`JOIN`/`ORDER BY` or unbounded `SELECT`s, breaking event/wire schema changes without defaults/upcasters, `alchemy.run.ts` vs `Env` binding drift. |
| **`effect-architecture-reviewer`** | `type:service`, `libs/es/**`, `libs/harness/**`, `adapters/**`, `apps/harness-mcp`, `changedLineCount >= 180` | Business nouns (`Cart`, `Order`, `Album`) leaking into `libs/es/**`/`libs/harness/**` production `src/`, God-interface `Context.Service` ports, domain policy in `type:infra`, `Layer.fresh` around stateful resources, `() => Effect`/`Layer` thunks, `SKILL.md` SDO/parity drift, modules nearing `SelfDogfooding.decide` ceilings. |
