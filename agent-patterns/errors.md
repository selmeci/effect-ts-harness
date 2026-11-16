# Error Handling and Tagged Errors

Errors in Effect are typed values tracked in the error channel E using Schema.TaggedError or Data.TaggedError, never thrown as untraced exceptions.

## Defining Tagged Errors

In Effect, failure is explicitly modeled in the error channel `E`. There are two main ways to define tagged errors:

### 1. `Schema.TaggedError` (Serializable Boundary Errors with Branded Fields)

Use `Schema.TaggedError` in `type:contract` for domain, API, and boundary errors that need schema validation, serialization, or client exposure. Every scalar field inside a `Schema.TaggedError` in `type:contract`, `type:core`, or `type:domain` must reference a branded schema (`.pipe(Schema.brand("<BrandName>"))`) rather than raw `Schema.String`, `Schema.Int`, or `Schema.Number` (`unbranded-contract-schema`, `harness:SPEC-0005` / `ADR-0007`):

```ts
import { Schema } from "effect"

export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const ErrorMessage = Schema.NonEmptyString.pipe(Schema.brand("ErrorMessage"))
export type ErrorMessage = typeof ErrorMessage.Type

export const CentsAmount = Schema.Natural.pipe(Schema.brand("CentsAmount"))
export type CentsAmount = typeof CentsAmount.Type

export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  {
    userId: UserId,
    message: ErrorMessage,
  },
) {}

export class InsufficientFundsError extends Schema.TaggedError<InsufficientFundsError>()(
  "InsufficientFundsError",
  {
    currentBalance: CentsAmount,
    requestedAmount: CentsAmount,
  },
) {}
```

### 2. `Data.TaggedError` (Internal Unserialized Errors)

Use `Data.TaggedError` for purely internal error types that do not cross network boundaries:

```ts
import { Data } from "effect"

export class CacheMissError extends Data.TaggedError("CacheMissError")<{
  readonly cacheKey: string
}> {}
```

## Raising Errors

Never use `throw` in Effect code — `throw` is strictly banned by `tools/oxlint/syntax-bans.js`. Instead, yield the error instance or use `Effect.fail`:

```ts
import { Effect } from "effect"
import { UserNotFoundError } from "contract/errors"

export const findUser = Effect.fn("Users.findUser")(function* (id: string) {
  const user = yield* lookupInDatabase(id)
  if (!user) {
    // Always return yield* new Error(...) to terminate execution and inform TypeScript
    return yield* new UserNotFoundError({
      userId: id,
      message: `User with id ${id} was not found`,
    })
  }
  return user
})
```

## Handling and Recovering from Errors

### Catching Specific Tagged Errors: `Effect.catchTag`

```ts
import { Effect } from "effect"

export const safeGetUser = findUser("usr_123").pipe(
  Effect.catchTag("UserNotFoundError", (error) => {
    // Recover with fallback value or alternative effect
    return Effect.succeed({ id: error.userId, name: "Guest User" })
  }),
)
```

### Catching Multiple Errors: `Effect.catchTags`

Use `Effect.catchTags` to handle multiple tagged error variants concisely:

```ts
import { Effect } from "effect"

export const processPayment = chargeCard(amount).pipe(
  Effect.catchTags({
    InsufficientFundsError: (error) =>
      Effect.logWarning(`Insufficient balance: ${error.currentBalance}`),
    NetworkTimeoutError: (error) => Effect.logError(`Payment gateway timed out: ${error.message}`),
  }),
)
```

### Catching All Errors: `Effect.catchAll`

```ts
export const fallbackProgram = riskyOperation.pipe(
  Effect.catchAll((error) => {
    return Effect.succeed(defaultFallback)
  }),
)
```

## Defects vs. Expected Errors

- **Expected errors** (`E` channel): Business logic failures, validatable client errors, network timeouts.
- **Defects** (`Effect.die`): Unrecoverable bugs or broken invariant assertions. Use `Effect.die` when an invariant fails that cannot be recovered by business logic.
- **Exhaustive Error Matching**: When inspecting an error union or `Result` / `Either` value directly rather than via `Effect.catchTags`, never use `switch (err._tag)` or `if (err._tag === ...)` — always use `match(err).with({ _tag: ... }, ...).exhaustive()` from `ts-pattern` (see [`pattern-matching.md`](./pattern-matching.md)).
