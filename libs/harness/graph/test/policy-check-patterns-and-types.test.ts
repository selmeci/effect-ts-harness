import { describe, expect, it } from "@effect/vitest"
import { checkEffectGraph } from "../src/policy-check.js"
import { extractTypeAwareGraphFromSource } from "../src/type-extractor.js"

describe("effect-graph:check pattern, schema, and type safety rules", () => {
  it("fails with discriminant-branching when an if statement or ternary narrows a union via a custom literal property", () => {
    const domainSource = `
import { Effect } from "effect"

export type PlanState =
  | { readonly tier: "free"; readonly limit: number }
  | { readonly tier: "pro"; readonly limit: number }

export const checkQuota = Effect.fn("Quota.check")((plan: PlanState, count: number) =>
  Effect.sync(() => {
    if (plan.tier === "free") {
      return count < 5
    }
    return count < 100
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "discriminant-branching")).toBe(true)
  })

  it("allows simple if-else when condition does not narrow a discriminated union", () => {
    const domainSource = `
import { Effect, Schema } from "effect"

const QuotaCount = Schema.Int.pipe(Schema.brand("QuotaCount"))
type QuotaCount = typeof QuotaCount.Type

export const checkCount = Effect.fn("Quota.checkCount")((count: QuotaCount) =>
  Effect.sync(() => {
    if (count <= 0) {
      return QuotaCount.make(0)
    } else {
      return count
    }
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
  })

  it("allows comparing discriminant against dynamic or generic variable without flagging discriminant-branching", () => {
    const domainSource = `
import { Effect } from "effect"

export type PlanState =
  | { readonly tier: "free"; readonly limit: number }
  | { readonly tier: "pro"; readonly limit: number }

export const hasTier = Effect.fn("Quota.hasTier")((plan: PlanState, expectedTier: PlanState["tier"]) =>
  Effect.sync(() => {
    if (plan.tier === expectedTier) {
      return true
    }
    return false
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
    expect(result.violations.some((v) => v.rule === "discriminant-branching")).toBe(false)
  })

  it("fails with non-exhaustive-union-match when match(union) terminates with .otherwise() instead of .exhaustive()", () => {
    const domainSource = `
import { Effect } from "effect"
import { match } from "ts-pattern"

export type PaymentResult =
  | { readonly kind: "Paid"; readonly receiptId: string }
  | { readonly kind: "Declined"; readonly reason: string }

export const formatPayment = Effect.fn("Payment.format")((res: PaymentResult) =>
  Effect.sync(() =>
    match(res)
      .with({ kind: "Paid" }, (r) => r.receiptId)
      .otherwise(() => "unknown")
  )
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.rule === "non-exhaustive-union-match")).toBe(true)
  })

  it("allows match(openPrimitive).otherwise() when matching on non-union open types like number or string", () => {
    const domainSource = `
import { type Brand, Effect } from "effect"
import { match, P } from "ts-pattern"

type HttpStatus = number & Brand.Brand<"HttpStatus">

export const classifyStatus = Effect.fn("Http.classifyStatus")((status: HttpStatus) =>
  Effect.sync(() =>
    match(status)
      .with(200, () => "ok" as const)
      .with(P.number.between(400, 499), () => "client-error" as const)
      .otherwise(() => "other" as const)
  )
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(true)
  })

  it("fails with discriminant-branching when array predicate filters by _tag === 'Fail'", () => {
    const domainSource = `
import { Effect } from "effect"

export type CauseReason =
  | { readonly _tag: "Fail"; readonly error: string }
  | { readonly _tag: "Die"; readonly defect: unknown }

export const inspectReasons = Effect.fn("Cause.inspect")((reasons: Array<CauseReason>) =>
  Effect.sync(() => {
    const fails = reasons.filter((r) => r._tag === "Fail")
    return fails.length
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "discriminant-branching")
    expect(violation).toBeDefined()
    expect(violation?.message).toContain("r._tag")
    expect(violation?.message).toContain(".filter()")
  })

  it("fails with discriminant-branching when aliasing a union discriminant in a local variable", () => {
    const domainSource = `
import { Effect } from "effect"

export type AppError =
  | { readonly _tag: "NotFound"; readonly id: string }
  | { readonly _tag: "Unauthorized"; readonly reason: string }

export const matchError = Effect.fn("Error.match")((err: AppError, expectedTag: string) =>
  Effect.sync(() => {
    const actualTag = err._tag
    if (actualTag !== expectedTag) {
      return false
    }
    return true
  })
)
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "discriminant-branching")
    expect(violation).toBeDefined()
    expect(violation?.message).toContain("actualTag")
  })

  it("fails with schema-boolean-state when Schema.Struct in contract uses checkedOut or created boolean flags", () => {
    const contractSource = `
import { Schema } from "effect"

export const Cart = Schema.Struct({
  id: Schema.String,
  checkedOut: Schema.Boolean
})

export const Order = Schema.Struct({
  id: Schema.String,
  created: Schema.optional(Schema.Boolean)
})
`
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: contractSource,
        packageTag: "contract",
      },
    ])

    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const booleanViolations = result.violations.filter((v) => v.rule === "schema-boolean-state")
    expect(booleanViolations).toHaveLength(2)
    expect(booleanViolations.some((v) => v.message.includes("checkedOut"))).toBe(true)
    expect(booleanViolations.some((v) => v.message.includes("created"))).toBe(true)
  })

  it("fails with fallback-json-equality when comparing values with JSON.stringify fallback", () => {
    const domainSource1 = `
      import { Equal } from "effect"

      export const checkEquality = (a: unknown, b: unknown): boolean => {
        return Equal.equals(a, b) || JSON.stringify(a) === JSON.stringify(b)
      }
    `
    const graph1 = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/compare1.ts",
        content: domainSource1,
        packageTag: "domain",
      },
    ])
    const result1 = checkEffectGraph(graph1)
    expect(result1.ok).toBe(false)
    const violations1 = result1.violations.filter((v) => v.rule === "fallback-json-equality")
    expect(violations1.length).toBeGreaterThan(0)
    expect(violations1[0]?.message).toContain("JSON.stringify equality fallback")

    const domainSource2 = `
      export const checkEqualityDirect = (a: unknown, b: unknown): boolean => {
        return JSON.stringify(a) === JSON.stringify(b)
      }
    `
    const graph2 = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/compare2.ts",
        content: domainSource2,
        packageTag: "domain",
      },
    ])
    const result2 = checkEffectGraph(graph2)
    expect(result2.ok).toBe(false)
    const violations2 = result2.violations.filter((v) => v.rule === "fallback-json-equality")
    expect(violations2.length).toBeGreaterThan(0)
    expect(violations2[0]?.message).toContain("JSON.stringify equality fallback")
  })

  it("fails with vacuous-error-assertion for thenFails(expected?: E) and thenFails() with 0 params, while allowing thenFails(expected: E)", () => {
    const badSource = `
      export interface TestHarness<E> {
        thenFails(expected?: E): void
      }

      export const runner = {
        thenFails: () => {
          // 0 params
        }
      }
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/bad-assert.ts",
        content: badSource,
        packageTag: "domain",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    expect(badResult.ok).toBe(false)
    const vacuousViolations = badResult.violations.filter(
      (v) => v.rule === "vacuous-error-assertion",
    )
    expect(vacuousViolations).toHaveLength(2)

    const goodSource = `
      export interface TestHarness<E> {
        thenFails(expected: E): void
      }

      export const runner = {
        thenFails: (expected: Error) => {
          // 1 explicit param
        }
      }
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/good-assert.ts",
        content: goodSource,
        packageTag: "domain",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    const goodViolations = goodResult.violations.filter((v) => v.rule === "vacuous-error-assertion")
    expect(goodViolations).toHaveLength(0)
  })

  it("fails with discriminant-branching when if branches on tag guard Exit.isSuccess(exit) in domain/core files", () => {
    const domainSource = `
      import { Exit } from "effect"

      export const handleExit = (exit: Exit.Exit<number, string>): number => {
        if (Exit.isSuccess(exit)) {
          return exit.value
        }
        return 0
      }
    `
    const graph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/handler.ts",
        content: domainSource,
        packageTag: "domain",
      },
    ])
    const result = checkEffectGraph(graph)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.rule === "discriminant-branching")
    expect(violation).toBeDefined()
    expect(violation?.message).toContain("Exit.isSuccess")
  })

  it("fails with unbranded-schema-field when Schema.Struct, TaggedStruct, or TaggedClass uses unbranded Int or Number for quantity or version", () => {
    const badContract = `
      import { Schema } from "effect"

      export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
        cartId: Schema.String,
        quantity: Schema.Int,
        expectedVersion: Schema.Number
      })

      export class CartUpdated extends Schema.TaggedClass<CartUpdated>()("CartUpdated", {
        cartId: Schema.String,
        streamVersion: Schema.Natural
      })

      export const LegacyPayload = Schema.Struct({
        quantity: Schema.Int.pipe(Schema.positive())
      })
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/events.ts",
        content: badContract,
        packageTag: "contract",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "unbranded-schema-field")
    expect(violations.length).toBe(4)
    expect(violations[0]?.message).toContain(
      "domain quantity and version fields must use a branded contract schema",
    )

    const goodContract = `
      import { Schema } from "effect"

      export const PositiveInt = Schema.Int.pipe(Schema.brand("PositiveInt"))
      export const StreamVersion = Schema.Int.pipe(Schema.brand("StreamVersion"))

      export const ItemAdded = Schema.TaggedStruct("ItemAdded", {
        cartId: Schema.String,
        quantity: PositiveInt,
        expectedVersion: StreamVersion
      })

      export class CartUpdated extends Schema.TaggedClass<CartUpdated>()("CartUpdated", {
        cartId: Schema.String,
        streamVersion: Schema.Natural.pipe(Schema.brand("NaturalVersion")),
        quantity: Schema.Int.pipe(Schema.positive(), Schema.brand("Quantity"))
      })
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/events.ts",
        content: goodContract,
        packageTag: "contract",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "unbranded-schema-field")).toHaveLength(0)
  })

  it("fails with schema-boolean-state on Schema.TaggedStruct and Schema.TaggedClass", () => {
    const badSource = `
      import { Schema } from "effect"

      export const CartTagged = Schema.TaggedStruct("CartTagged", {
        cartId: Schema.String,
        checkedOut: Schema.Boolean
      })

      export class CartClass extends Schema.TaggedClass<CartClass>()("CartClass", {
        cartId: Schema.String,
        isActive: Schema.Boolean
      })
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/cart.ts",
        content: badSource,
        packageTag: "contract",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    const boolViolations = badResult.violations.filter((v) => v.rule === "schema-boolean-state")
    expect(boolViolations.length).toBe(2)
  })

  it("fails with handwritten-tagged-union when type alias is an inline union of _tag object literals, but allows Schema-derived unions", () => {
    const badSource = `
      export type CartState =
        | { readonly _tag: "EmptyCart" }
        | { readonly _tag: "ActiveCart"; readonly cartId: string; readonly items: ReadonlyArray<string> }
        | { readonly _tag: "CheckedOutCart"; readonly cartId: string }
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/state.ts",
        content: badSource,
        packageTag: "contract",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    const violations = badResult.violations.filter((v) => v.rule === "handwritten-tagged-union")
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain("CartState")
    expect(violations[0]?.message).toContain(
      "handwritten TypeScript union of '_tag' object literals",
    )

    const goodSource = `
      import { Schema } from "effect"

      export const EmptyCart = Schema.TaggedStruct("EmptyCart", {})
      export const ActiveCart = Schema.TaggedStruct("ActiveCart", { cartId: Schema.String })
      export const CartState = Schema.Union(EmptyCart, ActiveCart)
      export type CartState = typeof CartState.Type

      export type Identifier = string | number
      export type ItemList = ReadonlyArray<{ readonly id: string; readonly name: string }>
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/state.ts",
        content: goodSource,
        packageTag: "contract",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "handwritten-tagged-union")).toHaveLength(
      0,
    )
  })

  it("fails with unsafe-type-cast on 'as any', ': any', 'as never', 'as unknown as', and '(x: never) => x', while allowing Effect.Effect<number, never, never>", () => {
    // 1. as any
    const asAnySource = `
      export const value = ("test" as any)
    `
    const asAnyGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/as-any.ts",
        content: asAnySource,
        packageTag: "domain",
      },
    ])
    const asAnyResult = checkEffectGraph(asAnyGraph)
    expect(asAnyResult.ok).toBe(false)
    expect(asAnyResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(asAnyResult.violations[0]?.message).toContain(
      "Explicit 'any' (as any, : any, <any>) is banned",
    )
    expect(asAnyResult.violations[0]?.path).toEqual(["libs/sample/domain/src/as-any.ts"])

    // 2. : any
    const colonAnySource = `
      export const badVar: any = 42
    `
    const colonAnyGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/colon-any.ts",
        content: colonAnySource,
        packageTag: "domain",
      },
    ])
    const colonAnyResult = checkEffectGraph(colonAnyGraph)
    expect(colonAnyResult.ok).toBe(false)
    expect(colonAnyResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(colonAnyResult.violations[0]?.message).toContain(
      "Explicit 'any' (as any, : any, <any>) is banned",
    )

    // 3. as never
    const asNeverSource = `
      export const castNever = (val: unknown) => val as never
    `
    const asNeverGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/as-never.ts",
        content: asNeverSource,
        packageTag: "domain",
      },
    ])
    const asNeverResult = checkEffectGraph(asNeverGraph)
    expect(asNeverResult.ok).toBe(false)
    expect(asNeverResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(asNeverResult.violations[0]?.message).toContain("Unsafe 'as never' cast is banned")

    // 4. as unknown as (double type assertion)
    const doubleCastSource = `
      export const doubleCast = (val: string) => val as unknown as number
    `
    const doubleCastGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/double-cast.ts",
        content: doubleCastSource,
        packageTag: "domain",
      },
    ])
    const doubleCastResult = checkEffectGraph(doubleCastGraph)
    expect(doubleCastResult.ok).toBe(false)
    expect(doubleCastResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(doubleCastResult.violations[0]?.message).toContain(
      "Double type assertion ('as unknown as T') is banned",
    )

    // 5. (x: never) => x parameter
    const neverParamSource = `
      export const neverParam = (x: never) => x
    `
    const neverParamGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/never-param.ts",
        content: neverParamSource,
        packageTag: "domain",
      },
    ])
    const neverParamResult = checkEffectGraph(neverParamGraph)
    expect(neverParamResult.ok).toBe(false)
    expect(neverParamResult.violations.some((v) => v.rule === "unsafe-type-cast")).toBe(true)
    expect(neverParamResult.violations[0]?.message).toContain(
      "Explicit ': never' annotation on parameter or variable is banned",
    )

    // 6. Allowing Effect.Effect<number, never, never>
    const safeNeverSource = `
      import { Effect } from "effect"
      export const safeEffect: Effect.Effect<number, never, never> = Effect.succeed(100)
    `
    const safeNeverGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/domain/src/safe-never.ts",
        content: safeNeverSource,
        packageTag: "domain",
      },
    ])
    const safeNeverResult = checkEffectGraph(safeNeverGraph)
    expect(safeNeverResult.violations.filter((v) => v.rule === "unsafe-type-cast")).toHaveLength(0)
  })

  it("fails with unbranded-contract-schema when contract/domain schemas, piped structs, unions, inline object type aliases, or any/unknown lack ~effect/Brand, and passes when branded", () => {
    const badContractSource = `
      import { Schema } from "effect"

      export type RawAlbumId = string
      export type ErasedId = any
      export type UnknownId = unknown
      export type InlineDto = { readonly id: string }
      export const PhotoId = Schema.Int

      const LocalUnbrandedId = Schema.Int
      export const PipedPhoto = Schema.Struct({
        id: LocalUnbrandedId,
        albumId: Schema.String
      }).pipe(Schema.brand("PipedPhoto"))

      export const EventUnion = Schema.TaggedUnion({
        Created: { itemId: Schema.String },
        Deleted: { itemId: Schema.String }
      })

      export class PhotoNotFoundError extends Schema.TaggedError<PhotoNotFoundError>()(
        "PhotoNotFoundError",
        { id: Schema.Int }
      ) {}

      export const BrandA = Schema.Int.pipe(Schema.brand("DuplicateBrand"))
      export const BrandB = Schema.NumberFromString.pipe(Schema.brand("DuplicateBrand"))

      export const JsonArrayDto = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })))
      export const PrimitiveArrayDto = Schema.Array(Schema.String)
      export const PrimitiveTupleDto = Schema.Tuple([Schema.String, Schema.Int])
      export const NestedStructDto = Schema.Struct({
        meta: Schema.Struct({ rawId: Schema.String })
      })
      export class CompositeError extends Schema.TaggedError<CompositeError>()(
        "CompositeError",
        {
          items: Schema.Array(Schema.Struct({ tag: Schema.String })),
        }
      ) {}
    `
    const badDomainSchemaSource = `
      import { Schema } from "effect"

      export const InternalStruct = Schema.Struct({
        rawCount: Schema.Int
      })
      export const InternalJsonArray = Schema.fromJsonString(Schema.Array(Schema.Struct({ rawLabel: Schema.String })))
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: badContractSource,
        packageTag: "contract",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: badDomainSchemaSource,
        packageTag: "domain",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    expect(badResult.ok).toBe(false)
    const contractViolations = badResult.violations.filter(
      (v) => v.rule === "unbranded-contract-schema",
    )
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Exported type alias 'RawAlbumId'") && v.message.includes("'string'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) => v.message.includes("Exported type alias 'ErasedId'") && v.message.includes("'any'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Exported type alias 'UnknownId'") && v.message.includes("'unknown'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) => v.message.includes("Exported type alias 'InlineDto'")),
    ).toBe(true)
    expect(contractViolations.some((v) => v.message.includes("Contract schema 'PhotoId'"))).toBe(
      true,
    )
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'id' of contract schema 'PipedPhoto'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'albumId' of contract schema 'PipedPhoto'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'itemId' of contract schema 'EventUnion'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) => v.message.includes("Field 'id' of 'PhotoNotFoundError'")),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Property 'rawCount' of contract schema 'InternalStruct'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some((v) =>
        v.message.includes("Duplicate Schema.brand('DuplicateBrand')"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Property 'id' of contract schema 'JsonArrayDto'") &&
          v.message.includes("unbranded primitive 'string'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Property 'rawLabel' of contract schema 'InternalJsonArray'") &&
          v.message.includes("unbranded primitive 'string'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("of contract schema 'PrimitiveArrayDto'") &&
          v.message.includes("unbranded primitive 'string'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("of contract schema 'PrimitiveTupleDto'") &&
          v.message.includes("unbranded primitive 'string'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Property 'rawId' of contract schema 'NestedStructDto'") &&
          v.message.includes("unbranded primitive 'string'"),
      ),
    ).toBe(true)
    expect(
      contractViolations.some(
        (v) =>
          v.message.includes("Field 'tag' of 'CompositeError'") &&
          v.message.includes("unbranded primitive 'string'"),
      ),
    ).toBe(true)

    const goodContractSource = `
      import { Schema } from "effect"

      export const PhotoId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PhotoId"))
      export type PhotoId = typeof PhotoId.Type

      export const PhotoIdFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(PhotoId))
      export type PhotoIdFromString = typeof PhotoIdFromString.Type

      export const AlbumId = Schema.String.pipe(Schema.brand("AlbumId"))
      export type AlbumId = typeof AlbumId.Type

      export const Photo = Schema.Struct({
        id: PhotoId,
        albumId: AlbumId
      })
      export type Photo = typeof Photo.Type

      export class PhotoNotFoundError extends Schema.TaggedError<PhotoNotFoundError>()(
        "PhotoNotFoundError",
        { id: PhotoId }
      ) {}
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/contract/src/index.ts",
        content: goodContractSource,
        packageTag: "contract",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "unbranded-contract-schema")).toEqual([])
  })

  it("fails with unbranded-primitive-boundary on raw primitive or inline object service/domain boundaries and 'as Brand' casts, and passes on compliant branded boundaries", () => {
    const badServiceSource = `
      import { type Brand, Context, type Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export class PhotoRepo extends Context.Service<PhotoRepo, {
        readonly findById: (id: number) => Effect.Effect<string>
        readonly createInline: (input: { readonly id: PhotoId }) => Effect.Effect<{ readonly ok: PhotoId }>
      }>()("PhotoRepo") {}
    `
    const badDomainSource = `
      import { type Brand, Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export const getPhoto = Effect.fn("Photo.get")(function* (
        rawId: number,
        inlineFilter: { readonly id: PhotoId }
      ) {
        const castId = rawId as PhotoId
        return yield* Effect.succeed(String(castId) + String(inlineFilter.id))
      })

      export const plainDecider = (input: { readonly current: PhotoId }): number =>
        input.current + 1
    `
    const badGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        content: badServiceSource,
        packageTag: "service",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: badDomainSource,
        packageTag: "domain",
      },
    ])
    const badResult = checkEffectGraph(badGraph)
    expect(badResult.ok).toBe(false)
    const boundaryViolations = badResult.violations.filter(
      (v) => v.rule === "unbranded-primitive-boundary",
    )
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Service capability 'PhotoRepo.findById' parameter 'id'"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Service capability 'PhotoRepo.findById' return type"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Service capability 'PhotoRepo.createInline' parameter 'input'") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Service capability 'PhotoRepo.createInline' return type") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Domain function 'getPhoto' parameter 'rawId'"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Domain function 'getPhoto' parameter 'inlineFilter'") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("Domain function 'getPhoto' return success type"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Domain function 'plainDecider' parameter 'input'") &&
          v.message.includes("inline object type literal"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some(
        (v) =>
          v.message.includes("Domain function 'plainDecider' return success type") &&
          v.message.includes("'number'"),
      ),
    ).toBe(true)
    expect(
      boundaryViolations.some((v) =>
        v.message.includes("casts an unbranded value directly to branded type"),
      ),
    ).toBe(true)

    const goodServiceSource = `
      import { type Brand, Context, type Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export class PhotoRepo extends Context.Service<PhotoRepo, {
        readonly findById: (id: PhotoId) => Effect.Effect<PhotoId>
      }>()("PhotoRepo") {}
    `
    const goodDomainSource = `
      import { type Brand, Effect } from "effect"

      type PhotoId = number & Brand.Brand<"PhotoId">

      export const getPhoto = Effect.fn("Photo.get")(function* (id: PhotoId) {
        return yield* Effect.succeed(id)
      })
    `
    const goodGraph = extractTypeAwareGraphFromSource([
      {
        filePath: "libs/sample/service/src/index.ts",
        content: goodServiceSource,
        packageTag: "service",
      },
      {
        filePath: "libs/sample/domain/src/index.ts",
        content: goodDomainSource,
        packageTag: "domain",
      },
    ])
    const goodResult = checkEffectGraph(goodGraph)
    expect(goodResult.violations.filter((v) => v.rule === "unbranded-primitive-boundary")).toEqual(
      [],
    )
  })
})
