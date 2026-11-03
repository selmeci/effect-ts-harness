---
id: harness:ADR-0008
title: "Real Cloudflare workerd Storage Execution and Ban on Hand-Rolled node:sqlite Mocks in Infrastructure Packages"
status: accepted
date: 2026-11-02
enforced_by:
  - tools/oxlint/syntax-bans.js
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/gates/src/gc-check.ts
  - libs/harness/gates/src/migration-check.ts
  - libs/sample/infra/test/index.test.ts
  - libs/es/infra/src/memory.ts
  - libs/es/infra/test/index.test.ts
spans:
  - GraphGc.decide
  - MigrationSafety.decide
  - AggregateInfra.initTables
  - SampleInfra.handleAlbumCounterRpc
services:
  - PhotoRepo
  - AlbumCounterClient
errors: []
---

# ADR-0008: Real Cloudflare `workerd` Storage Execution and Ban on Hand-Rolled `node:sqlite` Mocks in Infrastructure Packages

## Context and Problem Statement

Our applications and frameworks deploy to the Cloudflare Workers runtime (`workerd`) using Cloudflare D1 (`@effect/sql-d1`) and SQLite-backed Durable Objects (`@effect/sql-sqlite-do` with `enableSql: true`), provisioned and tested locally via Alchemy v2 (`@alchemy.run/cloudflare-runtime`).

Previously, infrastructure packages (`type:infra`) such as `@harness/sample-infra` and `@harness/es-infra` constructed hand-rolled storage adapters backed by Node's built-in `node:sqlite` (`DatabaseSync`) to emulate `D1Database`, `DurableObjectStorage`, and `SqlStorage` in unit and integration tests. This caused three systemic classes of defects across packages:

1. **Divergence in Transaction Semantics and SQLite Authorizer Rules:** Real Cloudflare `workerd` SQLite Durable Objects strictly forbid raw `BEGIN TRANSACTION`, `COMMIT`, `ROLLBACK`, and `SAVEPOINT` SQL statements through `state.storage.sql.exec()` (enforced by the C++ SQLite authorizer) and manage nested transactions via C++ savepoints inside `state.storage.transaction()` / `state.storage.transactionSync()`. Hand-rolled `node:sqlite` mocks implemented `storage.transaction()` by issuing raw `sqlite.exec("BEGIN")`, `sqlite.exec("COMMIT")`, and `sqlite.exec("ROLLBACK")` statements, masking bugs in nested transactions and rollback error handling.
2. **Mock Implementation Bugs Masquerading as Production Behavior:** Custom cursor and batch wrappers over `DatabaseSync` (`MockCursor.one()` returning `{}` on empty results, `Promise.all` fake D1 batching instead of `cloudflare-internal:d1-api` + `D1DatabaseObject`, and unguarded `ROLLBACK` calls swallowing primary exceptions) introduced test-only bugs while failing to test the real `workerd` wire and storage layer.
3. **Worker Bundle Contamination:** Placing or re-exporting `node:sqlite`-based test layers on `type:infra` entrypoints pulled Node-only built-ins into Cloudflare Worker bundles.

Because `@alchemy.run/cloudflare-runtime` (`cloudflareVitePlugin`, `Workerd.WorkerdLive`, `cloudflare-internal:d1-api`, `D1DatabaseObject`, and `PlatformProxy`) provides native execution of D1 and SQLite Durable Objects directly inside the real `workerd` runtime across the entire workspace, hand-rolled `node:sqlite` mocks in `type:infra` and `type:app` packages are obsolete and harmful.

## Decision Drivers

- Every `type:infra` and `type:app` package in the workspace (existing and future) must test D1 and Durable Object SQLite persistence against the real Cloudflare `workerd` engine (`@alchemy.run/cloudflare-runtime`).
- Hand-rolled `node:sqlite`, `sqlite`, or `better-sqlite3` storage mocks must be deterministically blocked in `type:infra` and `type:app` source and test files at both the fast AST lint level (`oxlint`) and the type-aware Effect graph / GC level (`checkEffectGraph` and `GraphGc.decide`).
- Internal harness tooling packages (`libs/harness/**`, `apps/harness-*`) that run on Node.js are unaffected and remain free from Cloudflare Worker runtime constraints.

## Considered Options

- **Option 1:** Workspace-Wide Two-Layer Ban on `node:sqlite` in `type:infra` / `type:app` (`oxlint` AST + `@harness/graph` / `GraphGc.decide`) Mandating Real `workerd` Storage via `@alchemy.run/cloudflare-runtime`.
- **Option 2:** Package-Local Convention in `@harness/es-*` Only Without Workspace-Wide Enforcement.
- **Option 3:** Retaining `node:sqlite` (`DatabaseSync`) Mocks Alongside `workerd` Integration Tests.

## Decision Outcome

**Chosen option:** "Workspace-Wide Two-Layer Ban on `node:sqlite` in `type:infra` / `type:app` (`oxlint` AST + `@harness/graph` / `GraphGc.decide`) Mandating Real `workerd` Storage via `@alchemy.run/cloudflare-runtime`", because this rule applies universally to every infrastructure and application package targeting Cloudflare Workers in our repository, not just `@harness/es-*`.

We enforce the following workspace-wide architectural rules:

1. **Ban on `node:sqlite` in `type:infra` and `type:app` (`libs/*/infra/**` and `apps/**`):** Importing `node:sqlite` (`DatabaseSync`), `sqlite`, or `better-sqlite3` or authoring hand-rolled `DurableObjectStorage`, `SqlStorage`, or `D1Database` mocks in any `type:infra` or `type:app` source or test file is strictly banned.
2. **Real `workerd` Execution via `@alchemy.run/cloudflare-runtime`:**
   - **D1 (`@effect/sql-d1` / Drizzle D1):** Infrastructure tests for D1 repositories (such as `PhotoRepo` and `AlbumCounterClient` in `@harness/sample-infra`) must execute against `WorkerdLive` hosting `D1DatabaseObject` (`enableSql: true`) and `cloudflare-internal:d1-api` via `@alchemy.run/cloudflare-runtime`.
   - **Durable Object SQLite (`@effect/sql-sqlite-do`):** Infrastructure tests and memory test layers (such as `SqlClientMemoryLayer` in `@harness/es-infra/memory`) must execute against `WorkerdLive` hosting a real Durable Object namespace with `enableSql: true`, delegating `storage.sql.exec()` and `storage.transaction()` (including nested savepoint transactions) to the `workerd` C++ runtime.
3. **Unified Schema Migration Enforcement (SqliteMigrator & MigrationSafety.decide):**
   - **Durable Object SQLite Migrations (`@effect/sql-sqlite-do`):** Schema migrations in `type:infra` (`libs/*/infra/src/**`) must execute transactionally via `@effect/sql-sqlite-do/SqliteMigrator` (`SqliteMigrator.run` / `SqliteMigrator.layer` with `SqliteMigrator.fromRecord` or `fromGlob`), tracking applied versions in `effect_sql_migrations` using `<positive_int>_<snake_case_name>` keys (such as `"1_init_tables"`). Ad-hoc DDL statements (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`) in `libs/*/infra/src/**` outside `SqliteMigrator` are strictly banned (`unmanaged-sql-ddl`), and malformed `fromRecord` keys that do not match `<positive_int>_<name>` are rejected (`invalid-migrator-record-key`).
   - **Destructive Migration Safety (`MigrationSafety.decide`):** `MigrationSafety.decide` (`unsafe-sql-migration`) statically scans both `.sql` migration files and `SqliteMigrator` DDL in `libs/*/infra/src/**`. Any migration containing `DROP`, SQLite table rebuilds (`__new_` / `PRAGMA foreign_keys=OFF`), or `ALTER TABLE ADD COLUMN ... NOT NULL` without `DEFAULT` is flagged and escalates to the human.

## Rejected Alternatives

### 1 · Package-Local Convention in `@harness/es-*` Only Without Workspace-Wide Enforcement

Defining the `workerd` storage requirement only inside `libs/es/docs/` (`es:ADR-0002`).

- **Why rejected:** The ban on `node:sqlite` in `type:infra` and `type:app` is a cross-cutting harness invariant that already governs `@harness/sample-infra` (`libs/sample/infra/test/index.test.ts`), `@harness/es-infra` (`libs/es/infra/src/memory.ts`), and every future infrastructure package in the monorepo. Scoping a workspace-wide rule to `libs/es/docs/` misrepresents its blast radius in the ontology graph.

### 2 · Retaining `node:sqlite` (`DatabaseSync`) Mocks Alongside `workerd` Integration Tests

Allowing `DatabaseSync(":memory:")` wrappers in unit tests while reserving `workerd` for manual E2E runs.

- **Why rejected:** Keeping a shared `workerd` instance warm per test file with per-test Durable Object isolation (`env.DO.idFromName(crypto.randomUUID())`) executes an entire 10-test suite in ~500ms while providing 100% fidelity with `workerd`'s C++ SQLite authorizer and savepoint semantics. Maintaining parallel `node:sqlite` mocks reintroduces semantic drift with zero meaningful speed advantage.

## Consequences and Enforcement

### Positive Consequences

- Every `type:infra` and `type:app` package in the workspace is guaranteed to test against real `workerd` D1 and Durable Object SQLite semantics (authorizer rules, C++ savepoints, cursor behavior).
- Immediate sub-second rejection of `node:sqlite` imports in `libs/*/infra/**` and `apps/**` via `oxlint` (`harness(syntax-bans)` and `harness(test-integrity)`) and `harness gc --strict` (`node-sqlite-in-infra`).

### Negative Consequences and Trade-offs

- Infrastructure packages (`type:infra`) must declare `@alchemy.run/cloudflare-runtime` in `devDependencies` and run tests within a `Scope` (`Effect.scoped` or scoped `Layer`) so `workerd` child processes and temporary disk directories are deterministically cleaned up.

### Deterministic Enforcement

| Rule                                                                                                                                                     | Enforced By                                                                                                                | Gate / Mechanism                                                           | Governed Symbols                                                                                    |
| :------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| Ban `node:sqlite`, `sqlite`, and `better-sqlite3` imports in `libs/*/infra/**` and `apps/**` source and test files                                       | `tools/oxlint/syntax-bans.js`                                                                                              | `harness/syntax-bans`, `harness/test-integrity` (`oxlint --deny-warnings`) | `GraphGc.decide`                                                                                    |
| Detect `node-sqlite-in-infra` across `type:infra` and `type:app` packages in the type-aware Effect graph and GC gate                                     | `libs/harness/graph/src/type-extractor.ts`, `libs/harness/graph/src/policy-check.ts`, `libs/harness/gates/src/gc-check.ts` | `checkEffectGraph`, `GraphGc.decide` (`node-sqlite-in-infra`)              | `GraphGc.decide`                                                                                    |
| Execute D1 and Durable Object SQLite infrastructure tests against real `workerd` via `@alchemy.run/cloudflare-runtime`                                   | `libs/sample/infra/test/index.test.ts`, `libs/es/infra/src/memory.ts`, `libs/es/infra/test/index.test.ts`                  | `WorkerdLive` (`@alchemy.run/cloudflare-runtime/core/workerd/Workerd`)     | `PhotoRepo`, `AlbumCounterClient`, `SampleInfra.handleAlbumCounterRpc`, `AggregateInfra.initTables` |
| Block ad-hoc SQL DDL (`unmanaged-sql-ddl`), malformed migrator keys (`invalid-migrator-record-key`), and destructive migrations (`unsafe-sql-migration`) | `tools/oxlint/syntax-bans.js`, `libs/harness/gates/src/migration-check.ts`, `libs/harness/gates/src/gc-check.ts`           | `harness/syntax-bans`, `GraphGc.decide`, `MigrationSafety.decide`          | `GraphGc.decide`, `MigrationSafety.decide`                                                          |
