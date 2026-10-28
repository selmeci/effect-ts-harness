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

