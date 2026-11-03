# Schedules, Retries, and Timeouts

Schedules model retry policies, repetition, and backoff as composable data structures used with Effect.retry and Effect.repeat.

## Building Schedules

In Effect, schedules are first-class data structures describing repetition, delay, and termination conditions:

```ts
import { Duration, Schedule } from "effect"

// Recur at most 3 times
export const retry3Times = Schedule.recurs(3)

// Exponential backoff starting at 100ms
export const exponentialBackoff = Schedule.exponential(Duration.millis(100))

// Fixed interval schedule
export const spacedPoll = Schedule.spaced(Duration.seconds(1))
```

## Composing Schedules

Compose schedules to create sophisticated retry strategies:

```ts
import { Duration, Schedule } from "effect"

// Exponential backoff with a maximum of 5 attempts and jitter
export const robustRetryPolicy = Schedule.exponential(Duration.millis(100)).pipe(
  Schedule.compose(Schedule.recurs(5)),
  Schedule.jittered,
)

// Intersecting schedules: terminates when either schedule terminates
export const cappedSchedule = Schedule.intersect(
  Schedule.spaced(Duration.seconds(2)),
  Schedule.recurs(10),
)
```

## Retrying Failed Effects: `Effect.retry`

Apply schedules to effects that fail:

```ts
import { Effect } from "effect"

export const callFlakyApiWithRetry = flakyApiCall.pipe(Effect.retry(robustRetryPolicy))

// Conditional retry based on the error tag
export const retryOnlyTransientErrors = flakyApiCall.pipe(
  Effect.retry({
    schedule: robustRetryPolicy,
    while: (error) => error._tag === "TransientNetworkError",
  }),
)
```

## Timeouts: `Effect.timeout`

Enforce execution deadlines using `Effect.timeout`:

```ts
import { Duration, Effect } from "effect"

export const queryWithTimeout = slowDatabaseQuery.pipe(
  // Automatically interrupts the effect if it exceeds 5 seconds
  Effect.timeout(Duration.seconds(5)),
)
```

## Repeating Effects: `Effect.repeat`

Use `Effect.repeat` to poll or repeat successful effects:

```ts
import { Duration, Effect, Schedule } from "effect"

export const pollJobStatus = checkJobStatus.pipe(
  Effect.repeat(
    Schedule.spaced(Duration.seconds(2)).pipe(
      Schedule.untilOutput((status) => status === "COMPLETED"),
    ),
  ),
)
```
