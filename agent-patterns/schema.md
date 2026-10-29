# Schema and Boundary Validation

Schema validates, parses, and transforms data across system boundaries, replacing raw JSON.parse and manual predicates with typed schemas.

## Defining Schemas in Effect v4

The `Schema` module defines models, decoders, encoders, and validators in one declaration:

```ts
import { Schema } from "effect"

// Struct schema for simple records
export const CreateUserInput = Schema.Struct({
  email: Schema.String,
  age: Schema.Int,
  isActive: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  nickname: Schema.optional(Schema.String)
})
export type CreateUserInput = typeof CreateUserInput.Type

// Schema.Class for domain entities with methods
export class User extends Schema.Class<User>("User")({
  id: Schema.String,
  email: Schema.String,
  age: Schema.Int,
  createdAt: Schema.Date
}) {
  get isAdult(): boolean {
    return this.age >= 18
  }
}
```

### Deriving TypeScript Types from Schemas

Never write loose handwritten TypeScript interfaces or types alongside Schema declarations (e.g. declaring `export type CommandResult = { ... }` with `number` and `ReadonlyArray` alongside `makeCommandResultSchema`). Handwritten loose types bypass Schema validation and allow illegal states (negative versions, empty arrays) to enter domain signatures.

Always derive types directly from the schema:
```ts
// For static schemas:
export const CommandResultSchema = Schema.Union(...)
export type CommandResult = Schema.Schema.Type<typeof CommandResultSchema>

// For schema factory functions:
export const makeCommandResultSchema = <State, Event>(...) => ...
export type CommandResult<State, Event> = Schema.Schema.Type<
  ReturnType<typeof makeCommandResultSchema<State, Event>>
>
```

### Numeric Precision: `Schema.Natural` vs Strictly Positive Integers

Never use `Schema.Int` or `Schema.Number` for quantities, counts, stock, or stream versions. `Schema.Int` permits negative integers (`-5`, `-1`), which violates domain invariants.

- Use `Schema.Natural` for non-negative integers ($\ge 0$): `availableQty`, `streamVersion`, `nextExpectedStreamVersion`, `count`.
- Strictly positive quantities ($> 0$, e.g. `orderQty`, `quantity`, `batchSize`, `limit`) must use `Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PositiveInt"))` — never use `Schema.Natural` for strictly positive quantities where `0` is invalid!

### Decode-Time Checks vs Compile-Time Branded Types

Crucially, **`Schema.Int` and `Schema.Natural` are decode-time filters whose TypeScript type is plain `number`**:
```ts
export const StreamVersion = Schema.Natural
export type StreamVersion = typeof StreamVersion.Type // -> number!
```
Because the TypeScript type is `number`, in-memory TypeScript code can pass `-1` or `1.5` to a function expecting `StreamVersion` without triggering a compiler error!

When compile-time type safety is needed for in-memory construction, always append `.pipe(Schema.brand("BrandName"))`:
```ts
// 0-based stream revisions and counters (0 is valid, compile-time branded)
export const StreamVersion = Schema.Natural.pipe(Schema.brand("StreamVersion"))
export type StreamVersion = typeof StreamVersion.Type // -> number & Brand<"StreamVersion">

// Strictly positive quantities (> 0, 0 is invalid, compile-time branded)
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("PositiveInt")
)
export type PositiveInt = typeof PositiveInt.Type // -> number & Brand<"PositiveInt">
```
Branded types prevent unvalidated raw numbers from being assigned at compile time without decoding through `Schema.decodeUnknown*` or constructing with `Brand.nominal`.

## Parsing and Decoding Untrusted Input

Always decode unknown boundaries with `Schema.decodeUnknownEffect` or `Schema.decodeUnknownSync`:

```ts
import { Effect, Schema } from "effect"

export const parseInput = Effect.fn("Input.parse")(function* (raw: unknown) {
  // Returns Effect<CreateUserInput, ParseError, never>
  const decoded = yield* Schema.decodeUnknownEffect(CreateUserInput)(raw)
  return decoded
})
```

## Mandatory Positive and Negative Decode Tests

Every constrained schema (`Schema.Int`, `Schema.Natural`, `PositiveInt`, `NonEmptyString`, branded types, and schemas with `check`) declared in `type:contract` **must** have both positive decode tests and negative rejection tests:

1. **Positive Decode Tests:** Assert that valid boundary values decode successfully to the expected runtime value and type.
2. **Negative Rejection Tests:** Assert that invalid values (`-1`, `0` when strictly positive, `1.5` for integers, `""` for non-empty strings, missing fields, `null`, `undefined`, wrong types) are rejected with `Either.Left` / `ParseError`.

```ts
import { describe, expect, it } from "vitest"
import { Either, Schema } from "effect"
import { NonEmptyString, PositiveInt, StreamVersion } from "contract/primitives"

describe("Primitives Contract Schemas", () => {
  describe("PositiveInt", () => {
    it("decodes valid positive integers", () => {
      const decoded = Schema.decodeUnknownSync(PositiveInt)(42)
      expect(decoded).toBe(42)
    })

    it("rejects zero, negative numbers, decimals, and non-numbers", () => {
      expect(Either.isLeft(Schema.decodeUnknownEither(PositiveInt)(0))).toBe(true)
      expect(Either.isLeft(Schema.decodeUnknownEither(PositiveInt)(-5))).toBe(true)
      expect(Either.isLeft(Schema.decodeUnknownEither(PositiveInt)(3.14))).toBe(true)
      expect(Either.isLeft(Schema.decodeUnknownEither(PositiveInt)("42"))).toBe(true)
      expect(Either.isLeft(Schema.decodeUnknownEither(PositiveInt)(null))).toBe(true)
    })
  })

  describe("StreamVersion", () => {
    it("decodes zero and positive integers", () => {
      expect(Schema.decodeUnknownSync(StreamVersion)(0)).toBe(0)
      expect(Schema.decodeUnknownSync(StreamVersion)(10)).toBe(10)
    })

    it("rejects negative integers and decimals", () => {
      expect(Either.isLeft(Schema.decodeUnknownEither(StreamVersion)(-1))).toBe(true)
      expect(Either.isLeft(Schema.decodeUnknownEither(StreamVersion)(0.5))).toBe(true)
    })
  })

  describe("NonEmptyString", () => {
    it("decodes non-empty strings", () => {
      expect(Schema.decodeUnknownSync(NonEmptyString)("hello")).toBe("hello")
    })

    it("rejects empty strings and non-strings", () => {
      expect(Either.isLeft(Schema.decodeUnknownEither(NonEmptyString)(""))).toBe(true)
      expect(Either.isLeft(Schema.decodeUnknownEither(NonEmptyString)(null))).toBe(true)
    })
  })
})
```

## JSON Parsing with `Schema.fromJsonString`

**Never use raw `JSON.parse`** — it is strictly banned by `tools/oxlint/syntax-bans.js`. Raw `JSON.parse` throws untraced exceptions and produces untyped `any`.

Instead, use `Schema.fromJsonString`:

```ts
import { Effect, Schema } from "effect"

// Composes JSON string parsing with schema decoding into a single step
export const UserFromJson = Schema.fromJsonString(CreateUserInput)

export const parseUserPayload = Effect.fn("User.parsePayload")(function* (jsonText: string) {
  const user = yield* Schema.decodeUnknownEffect(UserFromJson)(jsonText)
  return user
})
```

## Encoding and Serializing

Schemas work bi-directionally. Use `Schema.encodeEffect` or `Schema.encodeSync`:

```ts
import { Effect, Schema } from "effect"

export const serializeUser = (user: User) =>
  Schema.encodeEffect(User)(user)
```

## Data Transformations

Transform data during parsing using `Schema.transform` or `Schema.transformOrFail`:

```ts
import { Schema } from "effect"

export const TrimmedString = Schema.transform(
  Schema.String,
  Schema.String,
  {
    decode: (str) => str.trim(),
    encode: (str) => str
  }
)
```

## Refinements and Branded Types

Use built-in refinements for domain validation:

- `Schema.Int`: Integers only.
- `Schema.NonEmptyString`: String with at least one character.
- `Schema.between(min, max)`: Number bounds validation.
- `Schema.brand("BrandName")`: Nominal typing for identifiers.

## Discriminated Unions (`Schema.TaggedUnion`, `Schema.TaggedStruct`, `Schema.TaggedClass`)

Never model mutually exclusive states using boolean flags (`isPaid`, `isFailed`) or optional fields (`receiptId?: string`, `failureReason?: string`). Define closed discriminated unions in `type:contract` and branch on them exhaustively with `match(val)...exhaustive()` from `ts-pattern` (see [`pattern-matching.md`](./pattern-matching.md)):

```ts
import { Schema } from "effect"

export const PaymentStatus = Schema.TaggedUnion({
  Pending: { initiatedAt: Schema.Int },
  Paid: { receiptId: Schema.String, paidAt: Schema.Int },
  Declined: { reason: Schema.String }
})
export type PaymentStatus = typeof PaymentStatus.Type
```

## Tagged Errors (`Schema.TaggedError`)

Define serializable domain and boundary errors using the curried `Schema.TaggedError<Self>()("Tag", { ... })` syntax:

```ts
import { Schema } from "effect"

export class EntityNotFoundError extends Schema.TaggedError<EntityNotFoundError>()(
  "EntityNotFoundError",
  {
    entityId: Schema.String
  }
) {}
```

> [!NOTE]
> `Schema.TaggedErrorClass` was removed in Effect v4 runtime exports. Always use `Schema.TaggedError<Self>()("Tag", { ... })`.


