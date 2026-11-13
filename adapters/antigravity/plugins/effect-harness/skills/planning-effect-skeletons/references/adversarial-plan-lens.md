# Pre-Implementation Adversarial Plan Lens

This reference provides an adversarial audit checklist for evaluating `type:contract` Schemas, `type:service` interfaces, and `stub<A, E, R>()` skeletons immediately after `harness plan-check` exits `0`.

Auditing the plan graph before implementing code prevents expensive refactoring cycles. If a failure mode, concurrency race, or idempotency requirement is omitted from the skeleton's type signature, implementers are inevitably forced to distort domain boundaries or resort to `Effect.orDie`.

---

## The Pre-Implementation Adversarial Checklist

Audit the compilable skeleton against these five structural gates:

### 1. Idempotency Keys in Contract Inputs (`type:contract`)

In Cloudflare Workers and distributed environments, network retries and client reconnections cause identical requests to be submitted multiple times.

- [ ] **State-Mutating Payloads:** Does every state-mutating request schema (`HttpApiEndpoint`, `Rpc` command) contain an explicit client-supplied idempotency key (e.g. `commandId: Schema.UUID` or `idempotencyKey: Schema.NonEmptyString`)?
- [ ] **Deduplication Scope:** Is the idempotency key passed through to the repository / service signature so the infrastructure layer can enforce atomic deduplication inside the same database transaction?

### 2. Partial-Failure & Compensation Channels in `E` and `R`

Distributed operations that touch multiple subsystems (Durable Object SQLite, D1 database, Cloudflare Queues, R2 buckets) can fail between steps.

- [ ] **Inter-Step Failure Modeling:** If a workflow writes to SQLite and then dispatches a queue event or schedules a DO alarm, does the error channel `E` model step failures (e.g. `OutboxPublishError`, `QueueDeliveryError`)?
- [ ] **Compensation Signatures:** Does the service interface or use case signature expose compensation or retry capabilities in `R` (e.g. outbox sweeper or compensation decider) to recover from crashes between steps?

### 3. Optimistic Concurrency & Ordering Error Channels

Concurrent clients mutating the same state entity will race.

- [ ] **Versioned Mutation Inputs:** Do update/delete commands accept an `expectedVersion` or concurrency token?
- [ ] **Typed Concurrency Failure in `E`:** Does the use case or service method signature declare `OptimisticConcurrencyError` (or equivalent `ConflictError`) in its `E` union? If omitted from `E`, implementers will either swallow the conflict or crash the process via `Effect.die`.
- [ ] **Projection Ordering Errors:** Do event projection handlers account for out-of-order delivery with a typed sequencing error (e.g. `OutOfOrderEventError`) in `E`?

### 4. Decider Purity & Zero Layer Enforcement (`WHILE` Clauses)

EARS `WHILE <state>` clauses describe business policies and state transitions.

- [ ] **Zero Dependencies (`R = never`):** Verify that every decider function (`*.decide`) has `R = never` in its `stub<A, E, never>()` return type.
- [ ] **Deterministic Inputs:** Ensure deciders do not access clocks, random numbers, or environment globals directly. All state and environmental inputs must be passed explicitly as arguments.

### 5. Skeleton `E`-Channel Completeness (Preventing the `Effect.orDie` Trap)

Skeletons often declare optimistic, domain-only errors while ignoring operational realities.

- [ ] **Operational Error Coverage:** Skeletons must anticipate realistic infrastructure and concurrency errors:
  - Repository methods: `DatabaseError` / `SqliteError`
  - Durable Object RPC: `RpcTransportError` / `TimeoutError`
  - Cloud bindings (R2, Queues): `StorageError` / `QueueError`
- [ ] **No Hidden Defect Traps:** If infrastructure errors are missing from the planned `E` channel, implementers will be forced to wrap errors with `Effect.orDie` to satisfy the skeleton signature, which blinds the caller and destroys fault tolerance.

---

## Adversarial Audit Workflow

1. **Verify Topological Integrity:**
   Ensure `harness plan-check` passed with exit code `0` and inspect the output Mermaid topology:
   ```bash
   node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check
   ```
2. **Review Skeleton Signatures:**
   Check the `E` and `R` channels across all `stub<A, E, R>()` declarations in `type:domain` and `type:infra`.
3. **Dispatch `@effect-adversarial-reviewer`:**
   For high-risk, stateful, or event-sourced designs, invoke the adversarial specialist agent on the skeleton files (using `invoke_subagent` by default with `Model: "gemini-4-hydrogen-medium"` if in the `Model` enum, otherwise `"flash"` / `"inherit"`, or via `swarm` with `model: "gemini-4-hydrogen-medium"` when explicitly pinning):
   ```ts
   invoke_subagent({
     Subagents: [
       {
         TypeName: "effect-adversarial-reviewer",
         Role: "Adversarial Skeleton Reviewer",
         Model: "flash", // Use "gemini-4-hydrogen-medium" if in Model enum, or "inherit" if session runs on Hydrogen
         Workspace: "share",
         Prompt:
           "Audit the stub<A, E, R>() skeletons against the Pre-Implementation Adversarial Checklist. Target files: libs/sample/domain/src/skeletons.ts, libs/sample/contract/src/index.ts",
       },
     ],
   })
   ```
4. **Sign-Off & Transition:**
   Once all checklist items are verified or remediated in the skeleton signatures, proceed to `executing-effect-stubs`.
