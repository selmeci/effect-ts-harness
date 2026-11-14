import { Effect, Layer, Schema } from "effect"
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
  makeReadStdinEffect,
  recordFriction,
} from "./daemon-and-omnigraph.service.js"

export { classifyCommand, classifyFileWrite }

const NullableOptionalString = Schema.optional(Schema.NullOr(Schema.String))

const PreToolUseStdinSchema = Schema.Struct({
  tool_name: NullableOptionalString,
  tool_input: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        command: NullableOptionalString,
        file_path: NullableOptionalString,
        path: NullableOptionalString,
        filePath: NullableOptionalString,
        targetFile: NullableOptionalString,
      }),
    ),
  ),
  toolCall: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: NullableOptionalString,
        args: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              CommandLine: NullableOptionalString,
              command: NullableOptionalString,
              TargetFile: NullableOptionalString,
              AbsolutePath: NullableOptionalString,
              file_path: NullableOptionalString,
              filePath: NullableOptionalString,
              targetFile: NullableOptionalString,
              path: NullableOptionalString,
            }),
          ),
        ),
      }),
    ),
  ),
})

const READ_ONLY_TOOL_NAMES = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "view_file",
  "grep_search",
  "find_by_name",
  "list_dir",
  "read_file",
])

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

type GuardVerdictDecision =
  | { readonly verdict: "deny"; readonly reason: string }
  | { readonly verdict: "ask"; readonly reason: string | undefined }
  | { readonly verdict: "allow" }

const verdictRank = (v: GuardVerdictDecision["verdict"]): number =>
  match(v)
    .with("allow", () => 0)
    .with("ask", () => 1)
    .with("deny", () => 2)
    .exhaustive()

const pickStrictestDecision = (
  a: GuardVerdictDecision,
  b: GuardVerdictDecision,
): GuardVerdictDecision => (verdictRank(b.verdict) > verdictRank(a.verdict) ? b : a)

const toGuardCliResult = (decision: GuardVerdictDecision, isAntigravity: boolean): CliResult =>
  match(decision)
    .with({ verdict: "deny" }, ({ reason }) => formatDenyResult(isAntigravity, reason))
    .with({ verdict: "ask" }, ({ reason }) => formatAskResult(isAntigravity, reason))
    .with({ verdict: "allow" }, () => formatAllowResult(isAntigravity))
    .exhaustive()

const evaluateCommandDecision = (
  command: string,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<GuardVerdictDecision> =>
  Effect.gen(function* () {
    const classification = classifyCommand(command)
    if (classification !== "escalate") {
      return match<typeof classification, GuardVerdictDecision>(classification)
        .with("deny", () => ({ verdict: "deny", reason: formatCommandDenyReason(command) }))
        .with("allow", () => ({ verdict: "allow" }))
        .with("ask", () => ({
          verdict: "ask",
          reason: `Command requires human confirmation: ${command}`,
        }))
        .exhaustive()
    }

    if (options?.decisionLayer === undefined && options?.skipBackgroundDaemons !== true) {
      yield* ensureLocalOllamaReady().pipe(Effect.timeoutOption("2500 millis"))
    }
    const decision = yield* decideGuardCommand(command).pipe(Effect.provide(decisionLayer))
    recordFriction(options, {
      kind: "guard_escalation",
      summary: command,
      detail: `verdict=${decision.verdict}; reason=${decision.reason}`,
    })

    return match<typeof decision.verdict, GuardVerdictDecision>(decision.verdict)
      .with("deny", () => ({
        verdict: "deny",
        reason: isInteractiveNxCommand(command)
          ? `Blocked by harness guard: ${command} (${INTERACTIVE_NX_BANNED_REASON})`
          : `Blocked by harness guard: ${command}`,
      }))
      .with("allow", () => ({ verdict: "allow" }))
      .with("ask", () => ({ verdict: "ask", reason: decision.reason }))
      .exhaustive()
  })

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

    const invokedAsHook =
      isAntigravityFlag ||
      (positionalArgs.length === 0 &&
        !cliFilePath &&
        options?.stdin === undefined &&
        process.stdin.isTTY !== true)

    let rawStdin = options?.stdin
    if (
      positionalArgs.length === 0 &&
      !cliFilePath &&
      rawStdin === undefined &&
      process.stdin.isTTY !== true
    ) {
      const stdinRes = yield* Effect.result(
        makeReadStdinEffect({
          timeoutMs: options?.stdinTimeoutMs,
          maxBytes: options?.stdinMaxBytes,
        }),
      )
      const readFailed = match(stdinRes)
        .with({ _tag: "Success" }, ({ success }) => {
          rawStdin = success
          return undefined
        })
        .with({ _tag: "Failure" }, ({ failure }) =>
          formatDenyResult(
            isAntigravityFlag,
            `guard: failed or timed out reading hook stdin payload (${failure.reason})`,
          ),
        )
        .exhaustive()
      if (readFailed !== undefined) {
        return readFailed
      }
    }

    if (
      positionalArgs.length === 0 &&
      !cliFilePath &&
      invokedAsHook &&
      (rawStdin === undefined || rawStdin.trim().length === 0)
    ) {
      return formatDenyResult(isAntigravityFlag, "guard: empty hook stdin payload")
    }

    let stdinCmd: string | undefined
    let stdinFilePath: string | undefined
    let isAntigravityStdin = false
    let stdinDecodeFailureReason: string | undefined
    let isReadOnlyToolCall = false

    if (rawStdin !== undefined && rawStdin.trim().length > 0 && positionalArgs.length === 0 && !cliFilePath) {
      const stdinText = rawStdin
      const decoded = decodePreToolUseStdin(stdinText)
      match(decoded)
        .with({ _tag: "Some" }, ({ value }) => {
          const toolName = value.toolCall?.name ?? value.tool_name ?? undefined
          if (value.toolCall !== undefined && value.toolCall !== null) {
            isAntigravityStdin = true
            stdinCmd = value.toolCall.args?.CommandLine ?? value.toolCall.args?.command ?? undefined
            stdinFilePath =
              value.toolCall.args?.TargetFile ??
              value.toolCall.args?.AbsolutePath ??
              value.toolCall.args?.file_path ??
              value.toolCall.args?.filePath ??
              value.toolCall.args?.targetFile ??
              value.toolCall.args?.path ??
              undefined
          } else {
            stdinCmd = value.tool_input?.command ?? undefined
            stdinFilePath =
              value.tool_input?.file_path ??
              value.tool_input?.path ??
              value.tool_input?.filePath ??
              value.tool_input?.targetFile ??
              undefined
          }
          if (
            !stdinFilePath &&
            (!stdinCmd || stdinCmd.trim() === "")
          ) {
            if (toolName !== undefined && READ_ONLY_TOOL_NAMES.has(toolName)) {
              isReadOnlyToolCall = true
            } else {
              stdinDecodeFailureReason = "guard: hook stdin payload missing command or file path"
            }
          }
        })
        .with({ _tag: "None" }, () => {
          if (
            !isAntigravityFlag &&
            options?.stdin !== undefined &&
            !stdinText.trim().startsWith("{")
          ) {
            stdinCmd = stdinText
          } else {
            stdinDecodeFailureReason = "guard: malformed or unrecognized hook stdin JSON payload"
          }
        })
        .exhaustive()
    }

    const isAntigravity = isAntigravityFlag || isAntigravityStdin
    if (stdinDecodeFailureReason !== undefined) {
      return formatDenyResult(isAntigravity, stdinDecodeFailureReason)
    }

    const filePath = cliFilePath ?? stdinFilePath
    const command = positionalArgs.length > 0 ? positionalArgs.join(" ") : (stdinCmd ?? "")
    const hasCommand = command.trim().length > 0

    if (filePath && hasCommand) {
      const fileGuard = classifyFileWrite(filePath)
      const fileDecision: GuardVerdictDecision = match<typeof fileGuard.verdict, GuardVerdictDecision>(
        fileGuard.verdict,
      )
        .with("deny", () => ({
          verdict: "deny",
          reason: fileGuard.reason ?? `Blocked file write: ${filePath}`,
        }))
        .with("ask", () => ({ verdict: "ask", reason: fileGuard.reason }))
        .with("allow", () => ({ verdict: "allow" }))
        .exhaustive()
      const cmdDecision = yield* evaluateCommandDecision(command, options, decisionLayer)
      return toGuardCliResult(pickStrictestDecision(fileDecision, cmdDecision), isAntigravity)
    }

    if (filePath && !hasCommand) {
      const fileGuard = classifyFileWrite(filePath)
      const fileDecision: GuardVerdictDecision = match<typeof fileGuard.verdict, GuardVerdictDecision>(
        fileGuard.verdict,
      )
        .with("deny", () => ({
          verdict: "deny",
          reason: fileGuard.reason ?? `Blocked file write: ${filePath}`,
        }))
        .with("ask", () => ({ verdict: "ask", reason: fileGuard.reason }))
        .with("allow", () => ({ verdict: "allow" }))
        .exhaustive()
      return toGuardCliResult(fileDecision, isAntigravity)
    }

    if (!hasCommand) {
      if (isReadOnlyToolCall || !invokedAsHook) {
        return formatAllowResult(isAntigravity)
      }
      return formatDenyResult(isAntigravity, "guard: empty hook command payload")
    }

    const cmdDecision = yield* evaluateCommandDecision(command, options, decisionLayer)
    return toGuardCliResult(cmdDecision, isAntigravity)
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
