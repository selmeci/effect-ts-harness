# Schema and Boundary Validation

Schema validates, parses, and transforms data across system boundaries, replacing raw JSON.parse and manual predicates with typed schemas.

## Defining Schemas in Effect v4

The `Schema` module defines models, decoders, encoders, and validators in one declaration:

```ts
import { Brand, Schema } from "effect"

// 1. Always define branded scalar schemas first in type:contract
export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const EmailAddress = Schema.NonEmptyString.pipe(Schema.brand("EmailAddress"))
export type EmailAddress = typeof EmailAddress.Type

export const AgeYears = Schema.Natural.pipe(Schema.brand("AgeYears"))
export type AgeYears = typeof AgeYears.Type

export const TagLabel = Schema.NonEmptyString.pipe(Schema.brand("TagLabel"))
export type TagLabel = typeof TagLabel.Type

export const Nickname = Schema.NonEmptyString.pipe(Schema.brand("Nickname"))
export type Nickname = typeof Nickname.Type

// 2. Compose Struct schemas from branded domain schemas (never raw Schema.String / Schema.Int)
export const CreateUserInput = Schema.Struct({
  email: EmailAddress,
  age: AgeYears,
  isActive: Schema.Boolean,
  tags: Schema.Array(TagLabel),
  nickname: Schema.optional(Nickname),
})
export type CreateUserInput = typeof CreateUserInput.Type

// 3. Schema.Class for domain entities with methods
export class User extends Schema.Class<User>("User")({
  id: UserId,
  email: EmailAddress,
  age: AgeYears,
  createdAt: Schema.Date,
}) {
  get isAdult(): boolean {
    return this.age >= 18
  }
}

// 4. Value-level Brand constructors in Effect v4 (Brand.nominal / Brand.make / Brand.check)
export const makeUserId = Brand.nominal<UserId>()
export type PositiveCount = Brand.Branded<number, "PositiveCount">
export const PositiveCount = Brand.check<PositiveCount>(Schema.isInt(), Schema.isGreaterThan(0))
export const PositiveCountFromFilter = Brand.make<PositiveCount>((n) =>
  Number.isInteger(n) && n > 0 ? undefined : `Expected positive integer count, got ${n}`,
)
export const PositiveCountSchema = Schema.Int.pipe(Schema.fromBrand("PositiveCount", PositiveCount))
```

### Deriving TypeScript Types from Schemas (No Inline Object Types)

Never write loose handwritten TypeScript interfaces, inline object types (`type X = { ... }` or `input: { readonly id: AlbumId }`), or raw primitive type aliases (`export type UserId = string`). Handwritten inline object types and raw aliases bypass `Schema` validation and branding gates (`harness/syntax-bans`, `unbranded-contract-schema`, `unbranded-primitive-boundary`).

Always define a `Schema` in `type:contract` and derive the TypeScript type directly from the schema:

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

- Use `Schema.Natural.pipe(Schema.brand("..."))` for non-negative integers ($\ge 0$): `availableQty`, `streamVersion`, `nextExpectedStreamVersion`, `count`.
- Strictly positive quantities ($> 0$, e.g. `orderQty`, `quantity`, `batchSize`, `limit`) must use `Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PositiveInt"))` — never use `Schema.Natural` for strictly positive quantities where `0` is invalid!

### Mandatory Compile-Time Branded Types (`Schema.brand` & `Brand.Branded`)

Crucially, **`Schema.String`, `Schema.NonEmptyString`, `Schema.Int`, and `Schema.Natural` are decode-time filters whose unbranded TypeScript type is plain `string` or `number`**:

```ts
// BANNED in type:contract — unbranded TypeScript type is plain `number`!
export const StreamVersion = Schema.Natural
export type StreamVersion = typeof StreamVersion.Type // -> number!
```

Because the unbranded TypeScript type is `number` or `string`, in-memory TypeScript code can accidentally swap `(userId, albumId)` or pass `-1` or `1.5` to a function expecting `StreamVersion` without triggering a compiler error.

Therefore, the Harness enforces **Branded Domain Types everywhere (`harness:SPEC-0005` / `harness:ADR-0007`)**:

1. **Contract Scalar Exports (`unbranded-contract-schema`):** Every exported scalar schema in `type:contract` must append `.pipe(Schema.brand("<BrandName>"))` (or `Schema.fromBrand("<BrandName>", BrandCtor)`). Each brand key belongs to one canonical schema; compose wire-level string decoders into that schema via `Schema.FiniteFromString.pipe(Schema.decodeTo(<BrandedSchema>))` rather than calling `Schema.brand("<BrandName>")` on a wider schema.
2. **Composite Schema Fields (`harness/syntax-bans` & `unbranded-contract-schema`):** Every non-boolean scalar field inside `Schema.Struct` (including piped structs), `Schema.Class`, `Schema.TaggedStruct`, `Schema.TaggedClass`, `Schema.TaggedUnion`, and `Schema.TaggedError` in `type:contract`, `type:domain`, and `type:core` must reference a branded schema rather than raw `Schema.String`, `Schema.NonEmptyString`, `Schema.Int`, `Schema.Natural`, or `Schema.Finite`.
3. **Domain & Service Boundaries (`unbranded-primitive-boundary` & `harness/syntax-bans`):** Exported `Effect.fn` use cases, `.decide` / `evolve` functions, `stub<A, E, R>` skeletons, and `Context.Service` capability methods must never accept or return raw `string`, `number`, `boolean`, `any`, `unknown`, or inline `{ ... }` object type literals — always use named contract schemas and types.
4. **No `as <BrandedType>` Assertions (`harness/syntax-bans` & `unbranded-primitive-boundary`):** Never cast raw values with `as UserId`. Construct branded values using `<BrandedSchema>.make(value)`, `Brand.make<T>(filter)(value)`, `Brand.check<T>(...checks)(value)`, `Brand.nominal<T>()(value)`, or `Schema.decodeUnknownEffect(<BrandedSchema>)(value)`.

```ts
// 0-based stream revisions and counters (0 is valid, compile-time branded)
export const StreamVersion = Schema.Natural.pipe(Schema.brand("StreamVersion"))
export type StreamVersion = typeof StreamVersion.Type // -> number & Brand<"StreamVersion">

// Strictly positive quantities (> 0, 0 is invalid, compile-time branded)
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("PositiveInt"),
)
export type PositiveInt = typeof PositiveInt.Type // -> number & Brand<"PositiveInt">
```

Branded types attach the phantom symbol `"~effect/Brand"` at compile time with zero runtime memory overhead and zero change to JSON / OpenAPI `Encoded` wire formats.

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

export const serializeUser = (user: User) => Schema.encodeEffect(User)(user)
```

## Data Transformations

Transform data during parsing using `Schema.transform` or `Schema.transformOrFail`:

```ts
import { Schema } from "effect"

export const TrimmedString = Schema.transform(Schema.String, Schema.String, {
  decode: (str) => str.trim(),
  encode: (str) => str,
})
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
  Declined: { reason: Schema.String },
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
    entityId: Schema.String,
  },
) {}
```

> [!NOTE]
> `Schema.TaggedErrorClass` was removed in Effect v4 runtime exports. Always use `Schema.TaggedError<Self>()("Tag", { ... })`.
