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

## Scoped Services with `Layer.scoped`

For services that represent long-lived stateful resources (such as database pools, network sockets, or background workers), use `Layer.scoped`:

```ts
import { Context, Effect, Layer } from "effect"

export class ConnectionPool extends Context.Service<
  ConnectionPool,
  {
    readonly execute: (query: string) => Effect.Effect<void>
  }
>()("infra/ConnectionPool") {
  static readonly Live = Layer.scoped(
    ConnectionPool,
    Effect.gen(function* () {
      yield* Effect.logInfo("Connecting connection pool...")

      yield* Effect.addFinalizer((exit) => Effect.logInfo("Closing connection pool..."))

      return ConnectionPool.of({
        execute: (query) => Effect.logInfo(`Running ${query}`),
      })
    }),
  )
}
```

## Interruption and Guarantee Rules

1. **Guaranteed Execution**: Finalizers registered via `Effect.acquireRelease` or `Effect.addFinalizer` will always execute, whether the fiber succeeds, fails with a tagged error, dies with a defect, or is cancelled by interruption.
2. **Never swallow defects in finalizers**: Finalizers should be safe cleanup operations. Any failure within a finalizer becomes a defect on the exiting fiber.

## Interruption Propagation & Atomic File Persistence

### Preserving Composite Interruption in `Effect.catchCause`

When catching causes with `Effect.catchCause`, beware of swallowed interruptions. A composite cause can hold both a typed error/defect and an interruption signal (e.g. when racing effects or joining concurrent fibers). Checking `Cause.hasInterruptsOnly(cause)` misses composite causes where interruption coincided with an error or defect, causing fibers to ignore shutdown signals (`catch-cause-interrupts-only`).

Always use `Cause.hasInterrupts(cause)` to detect interruption and re-propagate it via `Effect.failCause(cause)`:

```ts
import { Cause, Effect } from "effect"

export const safeCatchCause = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      // Re-propagate if the cause contains any interruption
      if (Cause.hasInterrupts(cause)) {
        return Effect.failCause(cause)
      }
      return Effect.logWarning(`Recovered from failure: ${Cause.pretty(cause)}`)
    }),
  )
```

### Crash-Safe Atomic Persistence with `Effect.acquireUseRelease`

Direct writes to target files can leave corrupted or partial content if a crash, process termination, or fiber interruption occurs mid-stream. Robust atomic file persistence writes to an isolated sibling `.tmp` file first and commits atomically with `fs.renameSync`.

Use `Effect.acquireUseRelease` to ensure that any unfinished temporary file is cleaned up via best-effort `fs.unlinkSync` on interruption or failure:

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
