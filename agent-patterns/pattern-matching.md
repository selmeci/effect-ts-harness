# Exhaustive Pattern Matching & Discriminated Unions (`ts-pattern` + `effect/Schema`)

Exhaustive structural pattern matching with `ts-pattern` (`match(value).with(...).exhaustive()`) and closed discriminated unions (`Schema.TaggedUnion`, `Schema.TaggedStruct`, `Schema.TaggedClass`) are the primary branching mechanism across the harness. Every state transition, domain command/event dispatch, and tagged union inspection must enumerate all variants explicitly so unhandled states fail at compile time (`NonExhaustiveError<Unhandled>`) instead of escaping to runtime.

## Authority & Ground-Truth Sources

- `repos/effect/LLMS.md` & `repos/effect/packages/effect/src/Schema.ts` (`Schema.TaggedStruct`, `Schema.TaggedUnion`, `Schema.TaggedClass`, `Schema.TaggedErrorClass`)
- `node_modules/ts-pattern` (`match`, `P`, `P.union`, `P.select`, `P.when`, `P.not`, `.exhaustive()`, `.otherwise()`)
- Enforced by:
  - Layer 1 (Fast AST Gate): `tools/oxlint/syntax-bans.js`
  - Layer 2 (Type-Aware Gate): `libs/harness/graph/src/type-extractor.ts` & `libs/harness/graph/src/policy-check.ts` (`discriminant-branching`, `non-exhaustive-union-match`)

---

## 1. Modeling State with Discriminated Unions (`type:contract`)

Never represent mutually exclusive domain states with boolean flags (`isLoading`, `isError`) or optional fields (`error?: string`, `receiptId?: string`). Always define a closed discriminated union using `_tag`:

```ts
import { Schema } from "effect"

// 1. Lightweight value-level variants with Schema.TaggedUnion:
export const SubscriptionTier = Schema.TaggedUnion({
  Free: { maxAlbums: Schema.Int },
  Pro: { maxAlbums: Schema.Int, customDomain: Schema.String },
  Enterprise: { dedicatedCluster: Schema.String }
})
export type SubscriptionTier = typeof SubscriptionTier.Type

// 2. Class-based variants with Schema.TaggedClass + Schema.Union:
export class UploadPending extends Schema.TaggedClass<UploadPending>()("UploadPending", {
  photoId: Schema.String
}) {}

export class UploadCompleted extends Schema.TaggedClass<UploadCompleted>()("UploadCompleted", {
  photoId: Schema.String,
  objectKey: Schema.String,
  sizeBytes: Schema.Int
}) {}

export const UploadState = Schema.Union([UploadPending, UploadCompleted])
export type UploadState = typeof UploadState.Type
```

---

## 2. Exhaustive Matching (`match(val)...exhaustive()`)

Use `match(val)` from `ts-pattern` and terminate with `.exhaustive()` whenever matching on a closed discriminated union or literal union — **even when the union has only 2 variants**:

```ts
import { Option } from "effect"
import { match, P } from "ts-pattern"
import type { SubscriptionTier, UploadState } from "@harness/sample-contract"

export const describeUploadState = (state: UploadState): string =>
  match(state)
    .with({ _tag: "UploadPending" }, ({ photoId }) => `Pending: ${photoId}`)
    .with({ _tag: "UploadCompleted" }, ({ photoId, sizeBytes }) => `Completed: ${photoId} (${sizeBytes}B)`)
    .exhaustive()

// Option<A> has 2 states ({ _tag: "None" } | { _tag: "Some", value: A }):
// Always enumerate both variants explicitly instead of if (Option.isSome(opt)):
export const formatOptionalCursor = (cursor: Option.Option<string>): string =>
  match(cursor)
    .with({ _tag: "None" }, () => "start")
    .with({ _tag: "Some", value: P.select() }, (c) => `after:${c}`)
    .exhaustive()
```

---

## 3. Combining `match(...)` with `Effect.fn` and `Effect.gen`

> **Critical TypeScript Generator Rule:** `.with(pattern, handler)` callbacks are ordinary functions, **not** generator functions (`function*`), so `yield*` cannot be used inside a `.with(...)` callback.
> Instead, each `.with(...)` branch must **return** an `Effect` (or a `Schema.TaggedErrorClass` / `Data.TaggedError` instance, which is directly yieldable in Effect v4), and the outer `Effect.fn` generator yields the resulting `Effect` once with `return yield* match(...)...exhaustive()`.

```ts
import { Effect } from "effect"
import { match, P } from "ts-pattern"
import { QuotaExceededError, type AlbumQuotaCommand, type AlbumQuotaEvent } from "@harness/sample-contract"

export const decideAlbumQuota = Effect.fn("Sample.decide")(function* (
  cmd: AlbumQuotaCommand
): Effect.fn.Return<AlbumQuotaEvent, QuotaExceededError> {
  return yield* match(cmd)
    .with(
      { currentCount: P.when((c) => c >= cmd.maxAllowed) },
      (c) =>
        new QuotaExceededError({
          albumId: c.albumId,
          currentCount: c.currentCount,
          maxAllowed: c.maxAllowed
        })
    )
    .otherwise((c) =>
      Effect.succeed({
        albumId: c.albumId,
        newCount: c.currentCount + 1
      })
    )
})
```

---

## 4. When `.otherwise()` and Simple `if / else` Are Allowed

| Construct | Verdict | Rule |
| :--- | :--- | :--- |
| `match(closedUnion)...exhaustive()` | **Required** | All discriminated unions (`_tag`, `kind`, `status`, custom literal tags, `Option`, `Either`, `Result`) must enumerate every state and end with `.exhaustive()`. |
| `match(closedUnion)...otherwise(...)` | **Banned** | Blocked by `syntax-bans` and `non-exhaustive-union-match` in `checkEffectGraph`. |
| `match(openValue)...otherwise(...)` | **Allowed** | Permitted **only** when matching on open/infinite types (`number`, `string`, `unknown`) or single-struct guard refinements (`P.when(...)`) where `.exhaustive()` cannot statically close the type. |
| `match(...)...run()` | **Banned** | `.run()` throws at runtime on unhandled states; always use `.exhaustive()` or (for open types) `.otherwise()`. |
| `switch (x) { ... }` | **Banned** | Banned in all domain/service/infra/app code by `syntax-bans`. |
| `if (...) ... else if (...)` | **Banned** | Multi-branch `if / else if` chains are banned; use `match(...)` with `.with(...)` branches. |
| `if (union.tag === "A")` / `Option.isSome(x)` | **Banned** | Branching on a union discriminant in `if / else` or ternary `? :` is banned by `syntax-bans` and `discriminant-branching` in `checkEffectGraph` — even for 2 variants. |
| Simple `if (count <= 0)` | **Allowed** | Simple 1-branch `if` or `if / else` is permitted **only** when the condition does not inspect a discriminant or tag of a union type. |
