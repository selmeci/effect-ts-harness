---
id: harness:SPEC-0006
title: Real Cloudflare workerd Storage Execution and Ban on Hand-Rolled node:sqlite Mocks Across Infrastructure Packages
status: accepted
archetype: framework
date: 2026-11-02
enforced_by:
  - tools/oxlint/syntax-bans.js
  - libs/harness/graph/src/model.ts
  - libs/harness/graph/src/type-extractor.ts
  - libs/harness/graph/src/extractor/ast-policy-extractor.ts
  - libs/harness/graph/src/policy-check.ts
  - libs/harness/gates/src/gc-check.ts
  - libs/harness/gates/src/migration-check.ts
  - libs/sample/infra/test/index.test.ts
  - libs/es/infra/src/memory.ts
  - libs/es/infra/test/index.test.ts
adrs:
  - harness:ADR-0008
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

# Real Cloudflare `workerd` Storage Execution and Ban on Hand-Rolled `node:sqlite` Mocks Across Infrastructure Packages

## Context

Infrastructure and application packages in this workspace (`type:infra` and `type:app`) target the Cloudflare Workers runtime (`workerd`) using Cloudflare D1 (`@effect/sql-d1`) and SQLite-backed Durable Objects (`@effect/sql-sqlite-do` with `enableSql: true`). Previously, tests in `@harness/sample-infra` and `@harness/es-infra` constructed hand-rolled storage adapters backed by Node's built-in `node:sqlite` (`DatabaseSync`) to emulate `D1Database`, `DurableObjectStorage`, and `SqlStorage`. Those mocks diverged from `workerd`'s C++ SQLite authorizer (which forbids raw `BEGIN`, `COMMIT`, `ROLLBACK`, and `SAVEPOINT` SQL statements through `state.storage.sql.exec()`), bypassed `workerd`'s C++ savepoint semantics in `state.storage.transaction()`, introduced mock-specific cursor/batch bugs, and contaminated Worker bundles with `node:sqlite`.

Existing Graph Context:

- **Reused Contracts / Services:** `PhotoRepo`, `AlbumCounterClient` in `@harness/sample-service`; `SqlClient` (`@effect/sql-d1` and `@effect/sql-sqlite-do`).
- **Reused Spans:** `GraphGc.decide` in `@harness/gates`, `SampleInfra.handleAlbumCounterRpc` in `@harness/sample-infra`, `AggregateInfra.initTables` in `@harness/es-infra`.
- **New Capabilities Needed:** Workspace-wide AST lint enforcement in `tools/oxlint/syntax-bans.js` (`harness/syntax-bans` and `harness/test-integrity`), type-aware graph and GC enforcement (`node-sqlite-in-infra`) in `@harness/graph` and `@harness/gates`, and real `workerd` execution via `@alchemy.run/cloudflare-runtime` (`WorkerdLive`, `D1DatabaseObject`, `cloudflare-internal:d1-api`, and SQLite Durable Objects with `enableSql: true`) across `@harness/sample-infra` and `@harness/es-infra`.

## Goal

Guarantee that every `type:infra` and `type:app` package in the workspace tests D1 and Durable Object SQLite persistence against the real Cloudflare `workerd` runtime via `@alchemy.run/cloudflare-runtime`, while deterministically blocking `node:sqlite`, `sqlite`, and `better-sqlite3` storage mocks at both the AST lint level and the Effect graph / GC level.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is a single sentence with bold keywords (**When**, **While**, **If ... then**, **Where**) and the modal **shall** or **shall not**.

## Requirements

### 1 · AST Lint Gate Banning `node:sqlite` in Infrastructure and Application Packages

**Source (`tools/oxlint/syntax-bans.js`):** Immediate sub-second rejection during `PostToolUse` and `pnpm lint`.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                      | Effect Symbol  | Verification |
| :------ | :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------- | :----------- |
| REQ-1.1 | Unwanted behaviour | **If** a source file in `libs/*/infra/**` or `apps/**` (excluding `apps/harness-*`) imports `node:sqlite`, `sqlite`, or `better-sqlite3` via static import, dynamic `import()`, or `require()`, **then** the `harness/syntax-bans` rule **shall** reject the import and instruct the author to use `@alchemy.run/cloudflare-runtime` (`workerd`) instead of hand-rolled `DatabaseSync` mocks.                    | GraphGc.decide | AstGate      |
| REQ-1.2 | Unwanted behaviour | **If** a test file in `libs/*/infra/**` or `apps/**` (excluding `apps/harness-*`) imports `node:sqlite`, `sqlite`, or `better-sqlite3` via static import, dynamic `import()`, or `require()`, **then** the `harness/test-integrity` rule **shall** reject the import and instruct the author to execute storage tests against real `workerd` D1 or SQLite Durable Objects via `@alchemy.run/cloudflare-runtime`. | GraphGc.decide | AstGate      |
| REQ-1.3 | Unwanted behaviour | **If** a source file in `libs/*/infra/src/**` executes SQL DDL outside `SqliteMigrator.fromRecord` migration records (`*Migrations` / `fromRecord({ ... })`) or passes a migration key that does not match `<positive_int>_<lowercase_snake_case>` (`/^[1-9]\d*_[a-z0-9_]+$/`), **then** the `harness/syntax-bans` rule **shall** reject the code with `unmanaged-sql-ddl` or `invalid-migrator-record-key`.     | GraphGc.decide | AstGate      |

### 2 · Type-Aware Graph and Zero-Entropy GC Gate (`node-sqlite-in-infra`)

**Source (`libs/harness/graph/src/extractor/ast-policy-extractor.ts`, `libs/harness/graph/src/extractor/test-and-governance-extractor.ts`, `libs/harness/graph/src/type-extractor.ts`, `policy-check.ts`, & `libs/harness/gates/src/gc-check.ts`):** Structural graph policy check and `GraphGc.decide` enforcement.

| ID      | Pattern            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Effect Symbol          | Verification |
| :------ | :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------- | :----------- |
| REQ-2.1 | Unwanted behaviour | **If** any source or test file in a `type:infra` or `type:app` package (excluding internal `libs/harness/**` and `apps/harness-*` tooling) contains a static import, dynamic `import()`, or `require()` of `node:sqlite`, `sqlite`, or `better-sqlite3`, **then** `checkEffectGraph` and `GraphGc.decide` **shall** report a `node-sqlite-in-infra` policy violation.                                                                                                       | GraphGc.decide         | UnitTest     |
| REQ-2.2 | Event-driven       | **When** `GraphGc.decide` evaluates a workspace where `type:infra` and `type:app` packages use `@alchemy.run/cloudflare-runtime` without `node:sqlite` imports, `GraphGc.decide` **shall** report zero `node-sqlite-in-infra` findings.                                                                                                                                                                                                                                     | GraphGc.decide         | UnitTest     |
| REQ-2.3 | Unwanted behaviour | **If** any infrastructure module in `libs/*/infra/src/**` contains SQL DDL outside `SqliteMigrator.fromRecord` migration records, migration keys that do not match `<positive_int>_<lowercase_snake_case>` (`/^[1-9]\d*_[a-z0-9_]+$/`) or duplicate numeric IDs, or destructive SQL migration statements, **then** `MigrationSafety.decide` and `GraphGc.decide` **shall** report an `unmanaged-sql-ddl`, `invalid-migrator-record-key`, or `unsafe-sql-migration` finding. | MigrationSafety.decide | UnitTest     |

### 3 · Real `workerd` Storage Execution in Infrastructure Suites

**Source (`libs/sample/infra/test/index.test.ts`, `libs/es/infra/src/memory.ts`, & `libs/es/infra/test/index.test.ts`):** Native Cloudflare `workerd` D1 and Durable Object SQLite verification.

| ID      | Pattern      | Requirement                                                                                                                                                                                                                                                                                                                                                        | Effect Symbol                     | Verification |
| :------ | :----------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------- | :----------- |
| REQ-3.1 | Event-driven | **When** D1 and Durable Object infrastructure tests execute in `@harness/sample-infra`, `PhotoRepo`, `AlbumCounterClient`, and `SampleInfra.handleAlbumCounterRpc` **shall** run against a real `workerd` runtime (`WorkerdLive`) hosting `D1DatabaseObject` (`enableSql: true`) and `cloudflare-internal:d1-api` via `@alchemy.run/cloudflare-runtime`.           | SampleInfra.handleAlbumCounterRpc | UnitTest     |
| REQ-3.2 | Event-driven | **When** Durable Object SQLite infrastructure tests execute via `SqlClientMemoryLayer` in `@harness/es-infra/memory`, `AggregateInfra.initTables` and all `SqlClient` transactions **shall** run against a real `workerd` SQLite Durable Object (`enableSql: true`) enforcing `workerd` SQLite authorizer rules and nested `storage.transaction()` C++ savepoints. | AggregateInfra.initTables         | UnitTest     |

## Assumptions

- **REQ-1.1 & REQ-2.1:** Internal harness CLI and MCP packages (`libs/harness/**`, `apps/harness-*`) run on Node.js rather than Cloudflare Workers and are explicitly scoped out of the `type:infra` / `type:app` `node:sqlite` ban.
- **REQ-3.1 & REQ-3.2:** `WorkerdLive` instances are managed as scoped Effect resources (`Effect.scoped` or `Layer.effect`) so `workerd` child processes and temporary Miniflare/workerd directories are deterministically cleaned up when the test scope closes.

## Out of scope

- Deploying live Cloudflare D1 databases or Durable Objects to remote Cloudflare accounts during local unit/integration test runs (`alchemy deploy` remains human-only).

## Known residual risks

- `PlatformProxy` (`connect`) in `@alchemy.run/cloudflare-runtime` (`2.0.0-beta.80`) serializes chained method calls (`arg.$ === "chain"`) at the top level of RPC arguments; array arguments such as `d1.batch([...])` require either running inside the worker script or issuing sequential prepared statement calls over the proxy.

## Acceptance criteria

- All requirement rows pass their declared Verification methods (`AstGate`, `UnitTest`).
- `pnpm harness plan-check`, `pnpm harness gc --strict`, and `pnpm harness verify` exit `0`.
