import { readFileSync } from "node:fs"
import { Effect, Layer, Option, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { decideGuardCommand, routeStep } from "@harness/decision"
import {
  CD_COMMAND_BANNED_REASON,
  classifyCommand,
  classifyFileWrite,
  INTERACTIVE_NX_BANNED_REASON,
  isCdCommand,
  isInteractiveNxCommand,
} from "@harness/gates"
import {
  type CliEnv,
  type CliResult,
  ensureLocalOllamaReady,
  recordFriction,
} from "./daemon-and-omnigraph.service.js"

export { classifyCommand, classifyFileWrite }

const PreToolUseStdinSchema = Schema.Struct({
  tool_name: Schema.optional(Schema.String),
  tool_input: Schema.optional(
    Schema.Struct({
      command: Schema.optional(Schema.String),
      file_path: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
    }),
  ),
  toolCall: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      args: Schema.optional(
        Schema.Struct({
          CommandLine: Schema.optional(Schema.String),
          command: Schema.optional(Schema.String),
          TargetFile: Schema.optional(Schema.String),
          AbsolutePath: Schema.optional(Schema.String),
          file_path: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
})

const decodePreToolUseStdin = Schema.decodeOption(Schema.fromJsonString(PreToolUseStdinSchema))

const formatAllowResult = (isAntigravity: boolean): CliResult => ({
  exitCode: 0,
  stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
  stderr: "",
})

const formatDenyResult = (isAntigravity: boolean, reason: string): CliResult =>
  isAntigravity
    ? {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "deny", reason }),
        stderr: "",
      }
    : {
        exitCode: 2,
        stdout: "",
        stderr: reason,
      }

const formatAskResult = (isAntigravity: boolean, reason: string | undefined): CliResult =>
  isAntigravity
    ? {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "ask", reason }),
        stderr: "",
      }
    : {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: reason,
          },
        }),
        stderr: "",
      }

const formatCommandDenyReason = (command: string): string =>
  isCdCommand(command)
    ? `Blocked by harness guard: ${command} (${CD_COMMAND_BANNED_REASON})`
    : isInteractiveNxCommand(command)
      ? `Blocked by harness guard: ${command} (${INTERACTIVE_NX_BANNED_REASON})`
      : `Blocked by harness guard: ${command}`

export const handleGuard = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const isAntigravityFlag = argv.includes("--format=antigravity")
    const fileFlag = argv.find((arg) => arg.startsWith("--file="))
    const cliFilePath = fileFlag ? fileFlag.slice("--file=".length) : undefined
    const positionalArgs = argv
      .slice(1)
      .filter((arg) => !arg.startsWith("--format=") && !arg.startsWith("--file="))

    let rawStdin = options?.stdin
    if (
      positionalArgs.length === 0 &&
      !cliFilePath &&
      rawStdin === undefined &&
      !process.stdin.isTTY
    ) {
      rawStdin = yield* Effect.try({
        try: () => readFileSync(0, "utf8"),
        catch: () => "",
      }).pipe(Effect.orElseSucceed(() => ""))
    }

    let stdinCmd: string | undefined
    let stdinFilePath: string | undefined
    let isAntigravityStdin = false
    if (rawStdin) {
      const decoded = decodePreToolUseStdin(rawStdin)
      if (Option.isSome(decoded)) {
        if (decoded.value.toolCall !== undefined) {
          isAntigravityStdin = true
          stdinCmd =
            decoded.value.toolCall.args?.CommandLine ?? decoded.value.toolCall.args?.command
          stdinFilePath =
            decoded.value.toolCall.args?.TargetFile ??
            decoded.value.toolCall.args?.AbsolutePath ??
            decoded.value.toolCall.args?.file_path
        } else {
          stdinCmd = decoded.value.tool_input?.command
          stdinFilePath = decoded.value.tool_input?.file_path ?? decoded.value.tool_input?.path
        }
      }
    }
    const isAntigravity = isAntigravityFlag || isAntigravityStdin
    const filePath = cliFilePath ?? stdinFilePath
    const command = positionalArgs.length > 0 ? positionalArgs.join(" ") : (stdinCmd ?? "")

    if (filePath && command.trim() === "") {
      const fileGuard = classifyFileWrite(filePath)
      return match(fileGuard.verdict)
        .with("deny", () =>
          formatDenyResult(isAntigravity, fileGuard.reason ?? `Blocked file write: ${filePath}`),
        )
        .with("ask", () => formatAskResult(isAntigravity, fileGuard.reason))
        .with("allow", () => formatAllowResult(isAntigravity))
        .exhaustive()
    }

    if (command.trim() === "") {
      return formatAllowResult(isAntigravity)
    }

    const classification = classifyCommand(command)
    if (classification !== "escalate") {
      return match(classification)
        .with("deny", () => formatDenyResult(isAntigravity, formatCommandDenyReason(command)))
        .with("allow", () => formatAllowResult(isAntigravity))
        .with("ask", () =>
          formatAskResult(isAntigravity, `Command requires human confirmation: ${command}`),
        )
        .exhaustive()
    }

    if (options?.decisionLayer === undefined && process.env.VITEST === undefined) {
      yield* ensureLocalOllamaReady()
    }
    const decision = yield* decideGuardCommand(command).pipe(Effect.provide(decisionLayer))
    recordFriction(options, {
      kind: "guard_escalation",
      summary: command,
      detail: `verdict=${decision.verdict}; reason=${decision.reason}`,
    })

    return match(decision.verdict)
      .with("deny", () => {
        const denyReason = isInteractiveNxCommand(command)
          ? `Blocked by harness guard: ${command} (${INTERACTIVE_NX_BANNED_REASON})`
          : `Blocked by harness guard: ${command}`
        return formatDenyResult(isAntigravity, denyReason)
      })
      .with("allow", () => formatAllowResult(isAntigravity))
      .with("ask", () => formatAskResult(isAntigravity, decision.reason))
      .exhaustive()
  })

export const handleRoute = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const step = argv.slice(1).join(" ")
    const block = yield* routeStep(step).pipe(Effect.provide(decisionLayer))
    if (block === "review") {
      recordFriction(options, {
        kind: "route_miss",
        summary: step,
        detail:
          "IdiomRouterV1 returned review (no matching agent-patterns/*.md with >= 0.7 confidence)",
      })
    }
    const stdout = block === "review" || block === "effect" ? block : `agent-patterns/${block}.md`
    return { exitCode: 0, stdout, stderr: "" }
  })
