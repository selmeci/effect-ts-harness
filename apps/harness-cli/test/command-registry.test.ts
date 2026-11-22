import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer } from "effect"
import { match } from "ts-pattern"
import { CANONICAL_CLI_COMMAND_NAMES as CONTRACT_CLI_COMMAND_NAMES } from "@harness/contract"
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
    expect([...CONTRACT_CLI_COMMAND_NAMES]).toEqual([...COMMANDS])
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

  it.effect("REQ-4.1: executes custom command registered via makeHarnessCommandRegistryLayer", () =>
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
          }).pipe(Effect.provide(HarnessCommandRegistryLive), Effect.exit),
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

  it("F-9.1a: command-registry.ts has zero static imports of repo-checks.command or scenario.command", () => {
    const registryPath = resolve(import.meta.dirname, "../src/commands/command-registry.ts")
    const source = readFileSync(registryPath, "utf8")
    expect(source).not.toMatch(/from\s+["']\.\/repo-checks\.command\.js["']/)
    expect(source).not.toMatch(/from\s+["']\.\/scenario\.command\.js["']/)
    expect(source).toContain('import("./repo-checks.command.js")')
    expect(source).toContain('import("./scenario.command.js")')
  })

  it("C-6: guard subprocess does not load repo-checks, scenario, sample-contract, or cart fixture at runtime", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..")
    const tmp = mkdtempSync(join(tmpdir(), "harness-lazy-load-"))
    try {
      const logPath = join(tmp, "loaded-urls.txt")
      const hookPath = join(tmp, "record-loads.mjs")
      writeFileSync(
        hookPath,
        [
          'import { appendFileSync } from "node:fs"',
          'import { registerHooks } from "node:module"',
          `const logPath = ${JSON.stringify(logPath)}`,
          "registerHooks({",
          "  load(url, context, nextLoad) {",
          '    appendFileSync(logPath, `${url}\\n`, "utf8")',
          "    return nextLoad(url, context)",
          "  },",
          "})",
        ].join("\n"),
        "utf8",
      )

      const res = spawnSync(
        process.execPath,
        [
          "--import",
          "./tools/node-ts-resolver.mjs",
          "--import",
          hookPath,
          "apps/harness-cli/src/index.ts",
          "guard",
          "--format=antigravity",
        ],
        {
          cwd: repoRoot,
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" } }),
          encoding: "utf8",
          timeout: 15_000,
        },
      )

      expect(res.status).toBe(0)
      expect(JSON.parse(res.stdout.trim())).toEqual({ decision: "allow" })
      const loaded = readFileSync(logPath, "utf8")
      expect(loaded).toContain("guard-and-route.command.ts")
      expect(loaded).not.toContain("repo-checks.command.ts")
      expect(loaded).not.toContain("scenario.command.ts")
      expect(loaded).not.toContain("libs/sample/contract")
      expect(loaded).not.toContain("fixtures/cart")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
