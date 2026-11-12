import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { checkSpanBudgets, type SpanSample } from "@harness/gates"
import { runWithTestTracer, type IndexedEffectFn, type RecordedSpanEvent } from "@harness/ingest"
import {
  dispatchMcpTool,
  makeMcpToolRegistryLayer,
  McpToolName,
  McpToolRegistryLive,
  UnknownToolError,
  type McpToolPluginDescriptor,
} from "../src/tools/tool-registry.js"

const toSpanSamples = (spans: ReadonlyArray<RecordedSpanEvent>): ReadonlyArray<SpanSample> =>
  spans.map((s) => ({
    spanId: s.spanId,
    name: s.name,
    parentSpanId: s.parentSpanId,
    durationMs: s.durationMs,
    startTimeMs: s.startTimeMs,
    endTimeMs: s.endTimeMs,
    exitTag:
      s.exitTag === "Success" || s.exitTag === "Failure" || s.exitTag === "Defect"
        ? s.exitTag
        : undefined,
    errorTag: s.errorTag,
  }))

describe("HarnessMcp.dispatchTool (SPEC-0011 §4)", () => {
  it.effect(
    "REQ-4.3: executes registered MCP tool handler via McpToolRegistryLive, records HarnessMcp.dispatchTool span, and passes span budgets",
    () =>
      Effect.gen(function* () {
        const testId = "HarnessMcp.dispatchTool::registered"
        const emptyFnIndex = new Map<string, IndexedEffectFn>()

        const { result, spans } = yield* runWithTestTracer(
          testId,
          dispatchMcpTool({
            toolName: "harness_resolve",
            args: { symbolOrSpan: "SampleService" },
          }).pipe(Effect.provide(McpToolRegistryLive)),
          emptyFnIndex,
        )

        expect(result).toEqual({
          tool: "harness_resolve",
          args: { symbolOrSpan: "SampleService" },
        })

        const dispatchSpan = spans.find((s) => s.name === "HarnessMcp.dispatchTool")
        expect(dispatchSpan?.name).toBe("HarnessMcp.dispatchTool")
        expect(dispatchSpan?.exitTag).toBe("Success")

        const violations = checkSpanBudgets({ spans: toSpanSamples(spans) })
        expect(violations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-4.3: executes custom tool handler registered via makeMcpToolRegistryLayer",
    () =>
      Effect.gen(function* () {
        const testId = "HarnessMcp.dispatchTool::custom-layer"
        const emptyFnIndex = new Map<string, IndexedEffectFn>()

        const customDescriptor: McpToolPluginDescriptor = {
          name: McpToolName.make("custom_tool"),
          description: "Custom test tool",
          execute: (args) => Effect.succeed({ handled: true, payload: args }),
        }

        const customLayer = makeMcpToolRegistryLayer([customDescriptor])

        const { result, spans } = yield* runWithTestTracer(
          testId,
          dispatchMcpTool({
            toolName: "custom_tool",
            args: { query: "test" },
          }).pipe(Effect.provide(customLayer)),
          emptyFnIndex,
        )

        expect(result).toEqual({ handled: true, payload: { query: "test" } })

        const dispatchSpan = spans.find((s) => s.name === "HarnessMcp.dispatchTool")
        expect(dispatchSpan?.name).toBe("HarnessMcp.dispatchTool")
        expect(dispatchSpan?.exitTag).toBe("Success")

        const violations = checkSpanBudgets({ spans: toSpanSamples(spans) })
        expect(violations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-4.3 negative: fails with UnknownToolError when given unregistered tool name",
    () =>
      Effect.gen(function* () {
        const testId = "HarnessMcp.dispatchTool::unregistered"
        const emptyFnIndex = new Map<string, IndexedEffectFn>()

        const { result: exit, spans } = yield* runWithTestTracer(
          testId,
          dispatchMcpTool({
            toolName: "unknown_nonexistent_tool",
            args: {},
          }).pipe(
            Effect.provide(McpToolRegistryLive),
            Effect.exit,
          ),
          emptyFnIndex,
        )

        const dispatchSpan = spans.find((s) => s.name === "HarnessMcp.dispatchTool")
        expect(dispatchSpan?.name).toBe("HarnessMcp.dispatchTool")
        expect(dispatchSpan?.exitTag).toBe("Failure")

        const violations = checkSpanBudgets({ spans: toSpanSamples(spans), maxRepeatedChildCalls: 3 })
        expect(violations).toHaveLength(0)

        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            const errOpt = Cause.findErrorOption(cause)
            match(errOpt)
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(UnknownToolError)
                expect(value._tag).toBe("UnknownToolError")
                expect(value.toolName).toBe("unknown_nonexistent_tool")
              })
              .with({ _tag: "None" }, () => {
                expect.fail("Expected UnknownToolError in failure cause")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.fail("Expected dispatchMcpTool to fail for unregistered tool")
          })
          .exhaustive()
      }),
  )
})
