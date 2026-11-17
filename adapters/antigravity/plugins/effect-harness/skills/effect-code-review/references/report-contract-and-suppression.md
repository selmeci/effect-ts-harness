# Report Contract & Deterministic Suppression Reference

## 1. Positive Ordered 4-Section Report Recipe

Every `effect-code-review` output MUST follow this exact 4-section order:

```markdown
## 1. Scope & Routing Receipt
- **Target:** `<git diff range / branch / PR>`
- **Depth & Source:** `<skip | lite | focused | full>` (`<deterministic | model-augmented | degraded-fallback>`)
- **Touched Tiers & Scopes:** `<type:* / scope:*>`
- **Dispatched Specialists:** `<list of ReviewerIds or "none (skip)">`

## 2. Blocking Findings ([P0|P1] Quote-the-Line)
<!-- Emit one block per Confidence 100 or 75 finding; if none, state "None — 0 blocking findings." -->

## 3. Coverage & Suppressed Deterministic Gate Summary
- **Deterministic Gates Checked:** `harness_lsp_diagnostics`, `oxlint` (`tools/oxlint/syntax-bans.js`), `HarnessTierTopology.decide`, `SelfDogfooding.decide`, `MigrationSafety.decide` (`pnpm harness check-migrations`).
- **Suppressed Gate-Covered Items:** <count/summary of lint/type/tier issues delegated to deterministic gates, if any>
- **Suppressed Speculative Items (`Confidence: 50`):** <count only, omitted from blocking findings>

## 4. Remediation Handoff
- **Read-Only Guarantee:** Zero workspace files were modified during this review.
- **Next Step:** Route all `[P0|P1]` findings to `resolving-effect-review-feedback` (syncing EARS specs, ADRs, and `type:contract` schemas before dispatching fixes and running `pnpm harness verify`).
```

## 2. REQUIRED `[P0|P1]` Quote-the-Line Template

Every blocking finding (`Confidence: 100` or `75`) MUST include all 5 REQUIRED fields:

````markdown
### [P0|P1] <Short Descriptive Title>

- **Reviewer:** <effect-ears-test-reviewer | effect-adversarial-reviewer | effect-security-reviewer | effect-reliability-reviewer | effect-web-reviewer | effect-migration-contract-reviewer | effect-architecture-reviewer>
- **Confidence:** 100 | 75
- **Evidence:** `<file_path>:<line_number>`
  ```ts
  <verbatim quoted code or SQL snippet from the file>
  ```
- **Why It Matters:** <Concrete runtime bug, race, deploy-skew failure, security gap, or behavioral regression>
- **Suggested Fix:**
  ```ts
  <concrete Effect v4 / Schema / ts-pattern / SQL remediation snippet>
  ```
````

## 3. Hard False-Positive Suppression Gate

Suppress and **do not emit** as `[P0|P1]` findings any issue already enforced deterministically by:

| Deterministic Gate | Covered Violations (Suppress from Review Findings) |
| --- | --- |
| `@effect/tsgo` & `@effect/language-service` | Type errors, missing imports, JSX in `.ts` files, `floatingEffect`, `lazyEffect`. |
| `tools/oxlint/syntax-bans.js` | `as any` / `: any` / `as never` / `as unknown as T`, `async/await`, `new Promise`, `try/catch`, `throw`, raw `JSON.parse`, `switch` / `_tag` ternaries, `export *` (`facade-star-reexport`), `node:*` outside `type:infra`, unbranded `Schema` fields, raw DDL outside `SqliteMigrator.fromRecord`. |
| `HarnessTierTopology.decide` | Cross-tier import violations across `type:contract`, `type:service`, `type:core`, `type:domain`, `type:infra`, `type:app`, `scope:web`, and `impure-service-tier-import`. |
| `SelfDogfooding.decide` & `harness gc --strict` | Hard line-count ceiling breaches, unused `TaggedError`s / service tags, `impure-decider`. |
| `MigrationSafety.decide` (`pnpm harness check-migrations`) | `DROP TABLE`, `DROP COLUMN`, SQLite `__new_` / `PRAGMA foreign_keys=OFF` rebuilds, `ALTER TABLE ADD COLUMN ... NOT NULL` without `DEFAULT`. |

## 4. `8-Point Anti-Rubber-Stamp` Audit Summary (For `full` / `type:core` / `type:domain` Reviews)

When `effect-ears-test-reviewer` runs in `full` depth, verify:
1. Spec-vs-ADR polarity & procedural accuracy (no inverted EARS phrasing; accurate transaction boundaries).
2. ADR enforcement table fact-check (referenced files and rules exist on disk).
3. Folded state projection coverage (assertions on concrete state fields, not just emitted events).
4. Contract brand reuse (branded schemas from `type:contract` instead of raw primitives).
5. Meta-test failure arm coverage (every `Failure`/`Success` arm in test helpers exercised).
6. Aggregate identity & boundary state invariants (`command.<id> === state.<id>`, empty-active edges).
7. Contract decode negative matrix (rejects malformed/non-number inputs, not just out-of-range numbers).
8. `type:infra` guard-deletion audit (every `if (...)` guard and optional filter has a falsifying test).
