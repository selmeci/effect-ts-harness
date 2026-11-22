import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { vi } from "vitest"
import {
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
  toBoundedReason,
} from "@harness/contract"
import {
  decodeJsonFieldSafely,
  makeMintReplyKey,
  parseFiniteNumberOrString,
  toWorkflowStoreUnavailableError,
} from "../src/workflow/workflow-store-codec.js"

const PayloadSchema = Schema.Struct({ count: Schema.Int, label: Schema.NonEmptyString })

describe("workflow-store-codec pure helpers (SPEC-0026)", () => {
  it("parses finite numbers and trimmed numeric strings while rejecting whitespace and non-finite inputs", () => {
    expect(parseFiniteNumberOrString(0)).toBe(0)
    expect(parseFiniteNumberOrString(42.5)).toBe(42.5)
    expect(parseFiniteNumberOrString(Number.NaN)).toBeUndefined()
    expect(parseFiniteNumberOrString(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(parseFiniteNumberOrString("")).toBeUndefined()
    expect(parseFiniteNumberOrString("   ")).toBeUndefined()
    expect(parseFiniteNumberOrString(" 42 ")).toBe(42)
    expect(parseFiniteNumberOrString("-3.5")).toBe(-3.5)
    expect(parseFiniteNumberOrString("abc")).toBeUndefined()
    expect(parseFiniteNumberOrString("Infinity")).toBeUndefined()
    expect(parseFiniteNumberOrString(null)).toBeUndefined()
    expect(parseFiniteNumberOrString(undefined)).toBeUndefined()
    expect(parseFiniteNumberOrString({ value: 1 })).toBeUndefined()
  })

  it("maintains strict uniqueness and monotonicity when makeMintReplyKey overflows 1000 calls within a single millisecond", () => {
    let fakeNow = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow)
    try {
      const mint = makeMintReplyKey()
      const keys: Array<string> = []
      for (let i = 0; i < 1002; i += 1) {
        keys.push(mint())
      }
      fakeNow += 1
      keys.push(mint())
      keys.push(mint())

      expect(new Set(keys).size).toBe(keys.length)
      for (let i = 1; i < keys.length; i += 1) {
        expect(BigInt(keys[i - 1]!)).toBeLessThan(BigInt(keys[i]!))
      }
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("decodes JSON fields safely with Result isolation and normalizes store errors without double wrapping", () => {
    const okRes = decodeJsonFieldSafely('{"count":3,"label":"ok"}', PayloadSchema)
    match(okRes)
      .with({ _tag: "Success" }, ({ success }) => {
        expect(success).toEqual({ count: 3, label: "ok" })
      })
      .with({ _tag: "Failure" }, ({ failure }) =>
        expect.unreachable(`Expected Success, got ${failure}`),
      )
      .exhaustive()

    const badJson = decodeJsonFieldSafely("{not-json", PayloadSchema)
    expect(Result.isFailure(badJson)).toBe(true)

    const badShape = decodeJsonFieldSafely('{"count":"two","label":""}', PayloadSchema)
    expect(Result.isFailure(badShape)).toBe(true)

    const op = WorkflowStoreOperation.make("WorkflowStoreCodec.test")
    const existing = new WorkflowStoreUnavailableError({
      operation: op,
      reason: toBoundedReason("already normalized"),
    })
    expect(toWorkflowStoreUnavailableError(op, existing)).toBe(existing)

    const wrapped = toWorkflowStoreUnavailableError(op, new Error("socket closed"))
    expect(wrapped).toBeInstanceOf(WorkflowStoreUnavailableError)
    expect(wrapped.operation).toBe(op)
    expect(wrapped.reason).toContain("socket closed")
  })
})
