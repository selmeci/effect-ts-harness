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
