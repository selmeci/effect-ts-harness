# Concurrency and Fiber Coordination

Effect provides structured concurrency using Fibers, concurrent combinators, Queues, Deferred latches, and Semaphores without unhandled promise leaks.

## Concurrent Operations with `Effect.all`

Use `Effect.all` with the `concurrency` option to execute multiple effects in parallel:

```ts
import { Effect } from "effect"

export const fetchAllUsers = (userIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // Run up to 5 concurrent fetches
    const users = yield* Effect.all(
      userIds.map((id) => fetchUser(id)),
      { concurrency: 5 },
    )
    return users
  })

// Unbounded concurrency
export const fetchAllUnbounded = (effects: ReadonlyArray<Effect.Effect<string>>) =>
  Effect.all(effects, { concurrency: "unbounded" })
```

## Structured Fibers: `Effect.fork` and `Fiber`

Fibers are lightweight virtual threads of execution managed by the Effect runtime:

```ts
import { Effect, Fiber } from "effect"

export const runWithBackgroundWorker = Effect.gen(function* () {
  // Fork a child fiber
  const fiber = yield* Effect.fork(backgroundSyncTask)

  // Perform main work
  const result = yield* doMainWork

  // Join fiber to await result or interrupt if done
  yield* Fiber.interrupt(fiber)
  return result
})
```

Because of structured concurrency, child fibers are bound to their parent scope and will not leak as orphaned background promises.

## Asynchronous Coordination with `Deferred`

A `Deferred` represents a write-once variable that fibers can await:

```ts
import { Deferred, Effect } from "effect"

export const coordinateFibers = Effect.gen(function* () {
  const signal = yield* Deferred.make<string>()

  // Worker awaits the signal
  yield* Effect.fork(
    Effect.gen(function* () {
      const message = yield* Deferred.await(signal)
      yield* Effect.logInfo(`Worker received: ${message}`)
    }),
  )

  // Main fiber completes the deferred
  yield* Deferred.succeed(signal, "START_PROCESSING")
})
```

## Work Queues: `Queue`

Queues provide backpressure and thread-safe producer-consumer communication:

```ts
import { Effect, Queue } from "effect"

export const queuePipeline = Effect.gen(function* () {
  const queue = yield* Queue.bounded<number>(100)

  // Producer offers items
  yield* Queue.offer(queue, 1)
  yield* Queue.offer(queue, 2)

  // Consumer takes items
  const item = yield* Queue.take(queue)
  return item
})
```

## Rate Limiting with `Semaphore`

A `Semaphore` limits concurrent access to a resource via permits:

```ts
import { Effect } from "effect"

export const rateLimitedOperations = Effect.gen(function* () {
  const sem = yield* Effect.makeSemaphore(3)

  const runWithPermit = (task: Effect.Effect<void>) => sem.withPermit(task)

  yield* Effect.all(tasks.map(runWithPermit), { concurrency: "unbounded" })
})
```
