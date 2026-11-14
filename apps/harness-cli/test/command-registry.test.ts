import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { match } from "ts-pattern"
import { decideSpanBudgets, type SpanSample } from "@harness/gates"
import { runWithTestTracer, type IndexedEffectFn, type RecordedSpanEvent } from "@harness/ingest"
import {
  CANONICAL_CLI_COMMAND_NAMES,
  CliCommandName,
  CliCommandNotFoundError,
  DEFAULT_CLI_COMMAND_DESCRIPTORS,
  dispatchCliCommand,
  HarnessCommandRegistry,
  HarnessCommandRegistryLive,
  makeHarnessCommandRegistryLayer,
  type CliCommandPluginDescriptor,
} from "../src/commands/command-registry.js"
import { COMMANDS, runDeclarativeCli } from "../src/index.js"

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

describe("HarnessCli.dispatchCommand (SPEC-0011 §4)", () => {
  it("REQ-4.1: CANONICAL_CLI_COMMAND_NAMES and DEFAULT_CLI_COMMAND_DESCRIPTORS match COMMANDS 1-to-1", () => {
    expect([...CANONICAL_CLI_COMMAND_NAMES]).toEqual([...COMMANDS])
    expect(DEFAULT_CLI_COMMAND_DESCRIPTORS.map((d) => d.name)).toEqual([...COMMANDS])
  })

  it.effect("REQ-4.1: makeHarnessCommandRegistryLayer dies on duplicate command registration", () =>
    Effect.gen(function* () {
      const dupDescriptor: CliCommandPluginDescriptor = {
        name: CliCommandName.make("guard"),
        summary: "Duplicate guard descriptor",
        execute: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      }
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(makeHarnessCommandRegistryLayer([dupDescriptor, dupDescriptor]))),
      )
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }),
  )

  it.effect(
    "REQ-4.1: executes registered command, records HarnessCli.dispatchCommand span, and passes span budgets",
    () =>
      Effect.gen(function* () {
        const testId = "HarnessCli.dispatchCommand::registered"
        const emptyFnIndex = new Map<string, IndexedEffectFn>()

        const { result, spans } = yield* runWithTestTracer(
          testId,
          dispatchCliCommand({
            command: "help",
            args: [],
          }).pipe(Effect.provide(HarnessCommandRegistryLive)),
          emptyFnIndex,
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("harness help")
        expect(result.stderr).toBe("")

        const dispatchSpan = spans.find((s) => s.name === "HarnessCli.dispatchCommand")
        expect(dispatchSpan?.name).toBe("HarnessCli.dispatchCommand")
        expect(dispatchSpan?.exitTag).toBe("Success")

        const violations = yield* decideSpanBudgets({ spans: toSpanSamples(spans) })
        expect(violations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-4.1: executes custom command registered via makeHarnessCommandRegistryLayer",
    () =>
      Effect.gen(function* () {
        const testId = "HarnessCli.dispatchCommand::custom-layer"
        const emptyFnIndex = new Map<string, IndexedEffectFn>()

        const customDescriptor: CliCommandPluginDescriptor = {
          name: CliCommandName.make("custom-cmd"),
          summary: "Custom test command",
          execute: (args) =>
            Effect.succeed({
              exitCode: 0,
              stdout: `custom:${args.join(",")}`,
              stderr: "",
            }),
        }

        const customLayer = makeHarnessCommandRegistryLayer([customDescriptor])

        const { result, spans } = yield* runWithTestTracer(
          testId,
          dispatchCliCommand({
            command: "custom-cmd",
            args: ["alpha", "beta"],
          }).pipe(Effect.provide(customLayer)),
          emptyFnIndex,
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("custom:alpha,beta")

        const dispatchSpan = spans.find((s) => s.name === "HarnessCli.dispatchCommand")
        expect(dispatchSpan?.name).toBe("HarnessCli.dispatchCommand")
        expect(dispatchSpan?.exitTag).toBe("Success")

        const violations = yield* decideSpanBudgets({ spans: toSpanSamples(spans) })
        expect(violations).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-4.2: fails with CliCommandNotFoundError when given unregistered command name",
    () =>
      Effect.gen(function* () {
        const testId = "HarnessCli.dispatchCommand::unregistered"
        const emptyFnIndex = new Map<string, IndexedEffectFn>()

        const { result: exit, spans } = yield* runWithTestTracer(
          testId,
          dispatchCliCommand({
            command: "unregistered-cmd",
            args: [],
          }).pipe(
            Effect.provide(HarnessCommandRegistryLive),
            Effect.exit,
          ),
          emptyFnIndex,
        )

        const dispatchSpan = spans.find((s) => s.name === "HarnessCli.dispatchCommand")
        expect(dispatchSpan?.name).toBe("HarnessCli.dispatchCommand")
        expect(dispatchSpan?.exitTag).toBe("Failure")

        const violations = yield* decideSpanBudgets({
          spans: toSpanSamples(spans),
          maxRepeatedChildCalls: 3,
        })
        expect(violations).toHaveLength(0)

        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            const errOpt = Cause.findErrorOption(cause)
            match(errOpt)
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(CliCommandNotFoundError)
                expect(value._tag).toBe("CliCommandNotFoundError")
                expect(value.command).toBe("unregistered-cmd")
                expect(value.availableCommands.length).toBeGreaterThan(0)
                expect(value.availableCommands).toContain(CliCommandName.make("guard"))
              })
              .with({ _tag: "None" }, () => {
                expect.fail("Expected CliCommandNotFoundError in failure cause")
              })
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => {
            expect.fail("Expected dispatchCliCommand to fail for unregistered command")
          })
          .exhaustive()
      }),
  )

  it.effect("REQ-4.1: runDeclarativeCli executes help and guard via effect/cli", () =>
    Effect.gen(function* () {
      const helpRes = yield* runDeclarativeCli(["help"])
      expect(helpRes.exitCode).toBe(0)
      expect(helpRes.stdout).toContain("harness help")

      const guardRes = yield* runDeclarativeCli(["guard", "pnpm test"])
      expect(guardRes.exitCode).toBe(0)
    }),
  )

  it.effect(
    "REQ-4.2..4.5: registers check-openapi, check-migrations, check-event-schemas, benchmark, and scenario",
    () =>
      Effect.gen(function* () {
        const registry = yield* HarnessCommandRegistry
        for (const name of [
          "check-openapi",
          "check-migrations",
          "check-event-schemas",
          "benchmark",
          "scenario",
        ] as const) {
          const resolved = yield* registry.resolveCommand(name)
          expect(resolved._tag).toBe("Some")
        }
      }).pipe(Effect.provide(HarnessCommandRegistryLive)),
  )
})
