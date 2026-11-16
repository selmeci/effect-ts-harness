# Resources and Scopes

Scope manages deterministic resource acquisition and release in Effect, guaranteeing finalizers execute even during errors or fiber interruption.

## Managing Lifecycles with `Effect.acquireRelease`

`Effect.acquireRelease` pairs resource allocation with its guaranteed release finalizer:

```ts
import { Effect, Scope } from "effect"

export interface FileHandle {
  readonly fd: number
  readonly read: Effect.Effect<string>
  readonly close: Effect.Effect<void>
}

export const openFile = (filename: string): Effect.Effect<FileHandle, Error, Scope.Scope> =>
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

export const readFileContents = (filename: string) =>
  Effect.gen(function* () {
    const handle = yield* openFile(filename)
    const content = yield* handle.read
    return content
  }).pipe(Effect.scoped)
```

## Scoped Services with `Layer.scoped` (`type:service` Port + `type:infra` Layer)

For services that represent long-lived stateful resources (such as database pools, network sockets, or background workers), declare the pure `Context.Service` port in `type:service` and construct the `Layer.scoped` implementation in `type:infra` (`impure-service-tier-import`):

```ts
// In libs/sample/service/src/connection-pool.ts (type:service — pure port)
import { Context, Effect } from "effect"

export class ConnectionPool extends Context.Service<
  ConnectionPool,
  {
    readonly execute: (query: string) => Effect.Effect<void>
  }
>()("myapp/ConnectionPool") {}

// In libs/sample/infra/src/connection-pool-live.ts (type:infra — scoped Layer)
import { Effect, Layer } from "effect"
import { ConnectionPool } from "@harness/sample-service"

export const ConnectionPoolLive = Layer.scoped(
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

### Preserving Composite Causes & Pure Interruption Classification (`bare-cause-has-interrupts`)

When catching causes with `Effect.catchCause`, a composite `Cause` can hold both a typed error/defect (`Fail` / `Die`) and an interruption signal (`Interrupt`). Calling bare `Cause.hasInterrupts(cause)` or `Cause.hasInterruptsOnly(cause)` in production `src/` is **banned** by `SelfDogfooding.decide` and `tools/oxlint/syntax-bans.js` (`bare-cause-has-interrupts`), because misclassifying a mixed `Fail + Interrupt` cause as a pure interrupt silently drops the failure/defect or exits `0` on crash.

Always use `isPureInterruptCause(cause)` from `@harness/contract` (which checks `Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)`):

```ts
import { Cause, Effect } from "effect"
import { isPureInterruptCause } from "@harness/contract"

export const safeCatchCause = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      // Re-propagate pure fiber interruption without masking mixed Fail/Die causes
      if (isPureInterruptCause(cause)) {
        return Effect.failCause(cause)
      }
      return Effect.logError(`Failed with non-interrupt cause: ${Cause.pretty(cause)}`).pipe(
        Effect.andThen(Effect.failCause(cause)),
      )
    }),
  )
```

### Crash-Safe Atomic Persistence in `type:infra` (`Effect.acquireUseRelease` & `WorkspaceFs`)

Direct writes to target files can leave corrupted or partial content if a crash, process termination, or fiber interruption occurs mid-stream. Outside `type:infra` (`libs/*/infra/src/`), importing `node:fs` is banned by `no-node-builtins-outside-infra` (`SelfDogfooding.decide`) — non-infra tiers must call `WorkspaceFs.writeTextFileAtomic` from `@harness/service`.

Inside `type:infra` (`libs/*/infra/src/workspace-fs-live.ts`), implement atomic persistence by writing to an isolated sibling `.tmp` file first, committing atomically with `fs.renameSync`, and cleaning up unfinished `.tmp` files via `Effect.acquireUseRelease`:

```ts
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"

export const atomicallyWriteFile = (filePath: string, contents: string) => {
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
          try {
            fs.unlinkSync(tmpPath)
          } catch {
            // best-effort cleanup on failure or interruption
          }
        }
      }),
  )
}
```
