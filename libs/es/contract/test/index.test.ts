import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { PositiveInt, StreamVersion } from "../src/index.js"

describe("@harness/es-contract", () => {
  describe("StreamVersion", () => {
    it("decodes valid 0-based stream revisions", () => {
      expect(Schema.decodeSync(StreamVersion)(0)).toBe(0)
      expect(Schema.decodeSync(StreamVersion)(42)).toBe(42)
    })

    it("rejects negative numbers and non-integers", () => {
      const negative: unknown = -1
      const float: unknown = 1.5
      const nan: unknown = NaN
      expect(() => Schema.decodeUnknownSync(StreamVersion)(negative)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(float)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)("0")).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)("1")).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(null)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(undefined)).toThrow()
      expect(() => Schema.decodeUnknownSync(StreamVersion)(nan)).toThrow()
    })
  })

  describe("PositiveInt", () => {
    it("decodes strictly positive integers", () => {
      expect(Schema.decodeSync(PositiveInt)(1)).toBe(1)
      expect(Schema.decodeSync(PositiveInt)(100)).toBe(100)
    })

    it("rejects zero and negative numbers", () => {
      const zero: unknown = 0
      const negative: unknown = -5
      const float: unknown = 2.5
      const nan: unknown = NaN
      expect(() => Schema.decodeUnknownSync(PositiveInt)(zero)).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)(negative)).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)(float)).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)("0")).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)("1")).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)(null)).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)(undefined)).toThrow()
      expect(() => Schema.decodeUnknownSync(PositiveInt)(nan)).toThrow()
    })
  })
})
