# Resources and Scopes

`Scope` manages deterministic resource acquisition and release in Effect v4, guaranteeing finalizers execute even during errors or fiber interruption.

## Managing Lifecycles with `Effect.acquireRelease`

`Effect.acquireRelease` pairs resource allocation with its guaranteed release finalizer:

```ts
// Illustrative — scoped resource handle
import { Effect, Schema, Scope } from "effect"

export const FileName = Schema.NonEmptyString.pipe(Schema.brand("FileName"))
export type FileName = typeof FileName.Type

export interface FileHandle {
  readonly fd: number
  readonly read: Effect.Effect<string>
  readonly close: Effect.Effect<void>
}

export const openFile = (filename: FileName): Effect.Effect<FileHandle, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      yield* Effect.logInfo(`Opening file: ${filename}`)
      return {
        fd: 42,
        read: Effect.succeed("file contents"),
        close: Effect.logInfo(`Closed file: ${filename}`),
      }
    }),
    (handle, _exit) => handle.close,
  )
```

## Running Scoped Programs with `Effect.scoped`

When consuming a scoped effect, `Effect.scoped` supplies a fresh `Scope` that automatically closes when the effect completes, fails, or is interrupted:

```ts
import { Effect } from "effect"

export const readFileContents = (filename: FileName) =>
  Effect.gen(function* () {
    const handle = yield* openFile(filename)
    const content = yield* handle.read
    return content
  }).pipe(Effect.scoped)
```

## Scoped Services with `Layer.effect` (`type:service` Port + `type:infra` Layer)

For services that represent long-lived stateful resources (such as database pools, network sockets, or background workers), declare the pure `Context.Service` port with branded boundary types in `type:service` and construct the `Layer.effect` implementation using `Effect.addFinalizer` or `Effect.acquireRelease` in `type:infra` (`impure-service-tier-import`; note that Effect v3's `Layer.scoped` was merged into `Layer.effect` in Effect v4):

```ts
// Illustrative — Tier 1 & Tier 2: type:contract + type:service (pure port with branded boundary)
import { Context, Effect, Layer, Schema } from "effect"

export const SqlQueryText = Schema.NonEmptyString.pipe(Schema.brand("SqlQueryText"))
export type SqlQueryText = typeof SqlQueryText.Type

export class ConnectionPool extends Context.Service<
  ConnectionPool,
  {
    readonly execute: (query: SqlQueryText) => Effect.Effect<void>
  }
>()("myapp/ConnectionPool") {}

// Illustrative — Tier 4: type:infra (scoped Layer via Layer.effect + Effect.addFinalizer)
export const ConnectionPoolLive = Layer.effect(
  ConnectionPool,
  Effect.gen(function* () {
    yield* Effect.logInfo("Connecting connection pool...")

    yield* Effect.addFinalizer((_exit) => Effect.logInfo("Closing connection pool..."))

    return ConnectionPool.of({
      execute: (query) => Effect.logInfo(`Running ${query}`),
    })
  }),
)
```

## Interruption and Guarantee Rules

1. **Guaranteed Execution**: Finalizers registered via `Effect.acquireRelease` or `Effect.addFinalizer` will always execute, whether the fiber succeeds, fails with a tagged error, dies with a defect, or is cancelled by interruption.
2. **Never swallow defects in finalizers**: Finalizers should be safe cleanup operations. Any failure within a finalizer becomes a defect on the exiting fiber.

## Interruption Propagation & Atomic File Persistence

### Preserving Composite Causes & Pure Interruption Classification (`bare-cause-has-interrupts` & `catch-cause-interrupts-only`)

When catching causes with `Effect.catchCause`, a composite `Cause` can hold both a typed error/defect (`Fail` / `Die`) and an interruption signal (`Interrupt`). Both `bare-cause-has-interrupts` (enforced across production `src/`) and `catch-cause-interrupts-only` (enforced inside `Effect.catchCause` and `Exit` inspection) **ban** bare `Cause.hasInterrupts(cause)` and `Cause.hasInterruptsOnly(cause)` in `SelfDogfooding.decide`, `AstGateCache.decide`, and `tools/oxlint/syntax-bans.js`, because misclassifying a mixed `Fail + Interrupt` cause as a pure interrupt silently drops the failure/defect or exits `0` on crash.

Always use `isPureInterruptCause(cause)` from `@harness/contract` (which checks `Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)`) so pure fiber interruptions are re-propagated while non-interrupt causes log and recover cleanly:

```ts
import { Cause, Effect } from "effect"
import { isPureInterruptCause } from "@harness/contract"

export const recoverWithFallbackPreservingInterrupts = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: A,
): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      // Re-propagate pure fiber interruption without masking mixed Fail/Die causes
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(cause)
      }
      return Effect.logWarning(`Recovering from non-interrupt cause: ${Cause.pretty(cause)}`).pipe(
        Effect.as(fallback),
      )
    }),
  )
```

### Crash-Safe Atomic Persistence in `type:infra` (`Effect.acquireUseRelease` & `WorkspaceFs`)

Direct writes to target files can leave corrupted or partial content if a crash, process termination, or fiber interruption occurs mid-stream. Outside `type:infra` (`libs/*/infra/src/`), importing `node:fs` is banned by `no-node-builtins-outside-infra` (`SelfDogfooding.decide`) — non-infra tiers must call `WorkspaceFs.writeTextFileAtomic` from `@harness/service`.

Inside `type:infra` (`libs/*/infra/src/workspace-fs-live.ts`), implement atomic persistence by writing to an isolated sibling `.tmp` file first, committing atomically with `renameSync`, and cleaning up unfinished `.tmp` files via `Effect.acquireUseRelease` and `Result.try` (never raw `try / catch`, which is banned by `tools/oxlint/syntax-bans.js`):

```ts
// Illustrative — Tier 4: type:infra (e.g. libs/harness/infra/src/workspace-fs-live.ts)
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Result } from "effect"
import { WorkspaceFileContent, WorkspaceFilePath } from "@harness/contract"

export const atomicallyWriteFile = (
  filePath: WorkspaceFilePath,
  contents: WorkspaceFileContent,
) => {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`

  return Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.sync(() => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(tmpPath, contents, "utf-8")
        fs.renameSync(tmpPath, filePath)
      }),
    () =>
      Effect.sync(() => {
        if (fs.existsSync(tmpPath)) {
          Result.try(() => fs.unlinkSync(tmpPath))
        }
      }),
  )
}
```
