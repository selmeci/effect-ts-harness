import * as path from "node:path"
import { hasTokenReferencingHarnessCli } from "./policy-command-rules.js"
import {
  binaryBasename,
  expandCommandVariables,
  extractExecutedShellSnippets,
  hasUnexpandedShellVariable,
} from "./policy-harness-state.js"
import {
  extractDetailedCommandSegments,
  normalizeShellLineContinuations,
  type DetailedCommandSegment,
} from "./policy-shell-parser.js"
import {
  isProtectedDotHarnessInspectArg,
  matchesWorkerDaemonCredentialText,
} from "./policy-worker-paths.js"
import {
  BOOLEAN_FLAG_VALUE_PATTERN,
  DENO_EVAL_SUBCOMMANDS,
  DENO_RUN_SUBCOMMANDS,
  DENO_VALUE_FLAGS,
  HARNESS_GLOBAL_VALUE_FLAGS,
  HARNESS_INSPECT_BINARIES,
  HARNESS_OPTIONAL_BOOL_VALUE_FLAGS,
  HARNESS_WORKFLOW_VALUE_FLAGS,
  JS_RUNTIME_BINARIES,
  JS_RUNTIME_VALUE_FLAGS,
  MAX_SUBSHELL_INSPECT_DEPTH,
  NX_RUN_VALUE_FLAGS,
  SHELL_EXEC_BINARIES,
  applyPipedXargsTokens,
  extractEchoOrPrintfTokens,
  extractEmbeddedCommandPayloads,
  extractJsRuntimeEvalPayloads,
  isBlockedInlineJsEvalPayload,
  isHarnessCliTargetToken,
  matchesHarnessCliScriptPath,
  splitPipedSegments,
  unwrapWorkerCommandWords,
  type UnwrappedWorkerWords,
} from "./policy-worker-isolation-helpers.js"

export const WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS = [
  "start",
  "resume",
  "ship",
  "abort",
  "doctor",
  "complete --phase llm",
] as const

const WORKER_BLOCKED_WORKFLOW_ACTIONS: ReadonlySet<string> = new Set<string>([
  ...WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.filter((s) => !s.includes(" ")),
  "done",
])

export {
  classifyWorkerFileAccess,
  isWorkerDaemonCredentialFilePath,
  type WorkerFileAccessDenyRuleId,
  type WorkerFileAccessResult,
} from "./policy-worker-paths.js"

export { MAX_SUBSHELL_INSPECT_DEPTH, extractEmbeddedCommandPayloads }

export interface PolicyGuardOptions {
  readonly unitWorkerMode?: boolean | undefined
}

const extractHarnessCliArgs = (
  commandWords: ReadonlyArray<string>,
  allowLocalEntry: boolean,
): ReadonlyArray<string> | undefined => {
  const rawBin = commandWords[0]
  if (rawBin === undefined) return undefined
  const bin = binaryBasename(rawBin)
  if (bin === "harness") return commandWords.slice(1)
  if (!JS_RUNTIME_BINARIES.has(bin)) return undefined
  let skippedDenoSubcommand = false
  for (let i = 1; i < commandWords.length; i++) {
    const w = commandWords[i]!
    if (
      w === "-e" ||
      w === "--eval" ||
      w === "-p" ||
      w === "--print" ||
      w.startsWith("--eval=") ||
      w.startsWith("--print=") ||
      /^-e./.test(w) ||
      /^-p./.test(w)
    ) {
      return undefined
    }
    if (w === "--") {
      const script = commandWords[i + 1]
      return script !== undefined && matchesHarnessCliScriptPath(script, allowLocalEntry)
        ? commandWords.slice(i + 2)
        : undefined
    }
    if (JS_RUNTIME_VALUE_FLAGS.has(w) || (bin === "deno" && DENO_VALUE_FLAGS.has(w))) {
      i++
      continue
    }
    if (w.startsWith("-")) continue
    if (bin === "deno" && !skippedDenoSubcommand) {
      if (DENO_EVAL_SUBCOMMANDS.has(w)) return undefined
      if (DENO_RUN_SUBCOMMANDS.has(w)) {
        skippedDenoSubcommand = true
        continue
      }
    }
    return matchesHarnessCliScriptPath(w, allowLocalEntry) ? commandWords.slice(i + 1) : undefined
  }
  return undefined
}

const extractNxHarnessCliArgs = (
  commandWords: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  const rawBin = commandWords[0]
  if (rawBin === undefined || binaryBasename(rawBin) !== "nx") return undefined
  const extraArgs: Array<string> = []
  const positionals: Array<{ readonly value: string; readonly index: number }> = []
  let targetFlagVal: string | undefined
  let projectFlagVal: string | undefined
  let afterDash: ReadonlyArray<string> | undefined

  for (let i = 1; i < commandWords.length; i++) {
    const arg = commandWords[i]!
    if (arg === "--") {
      afterDash = commandWords.slice(i + 1)
      break
    }
    if (arg === "--args" && i + 1 < commandWords.length) {
      extraArgs.push(...commandWords[++i]!.trim().split(/\s+/).filter(Boolean))
      continue
    }
    if (arg.startsWith("--args=")) {
      extraArgs.push(...arg.slice("--args=".length).trim().split(/\s+/).filter(Boolean))
      continue
    }
    if (
      (arg === "-t" || arg === "--target" || arg === "--targets") &&
      i + 1 < commandWords.length
    ) {
      targetFlagVal = commandWords[++i]!
      continue
    }
    if (arg.startsWith("-t") && arg.length > 2) {
      targetFlagVal = arg.slice(2)
      continue
    }
    if (arg.startsWith("--target=") || arg.startsWith("--targets=")) {
      targetFlagVal = arg.slice(arg.indexOf("=") + 1)
      continue
    }
    if (
      (arg === "-p" || arg === "--project" || arg === "--projects") &&
      i + 1 < commandWords.length
    ) {
      projectFlagVal = commandWords[++i]!
      continue
    }
    if (arg.startsWith("-p") && arg.length > 2) {
      projectFlagVal = arg.slice(2)
      continue
    }
    if (arg.startsWith("--project=") || arg.startsWith("--projects=")) {
      projectFlagVal = arg.slice(arg.indexOf("=") + 1)
      continue
    }
    if (NX_RUN_VALUE_FLAGS.has(arg) && i + 1 < commandWords.length) {
      i++
      continue
    }
    if (!arg.startsWith("-")) positionals.push({ value: arg, index: i })
  }

  const p0 = positionals[0]?.value
  const p1 = positionals[1]
  if (p0 === "run" && p1 !== undefined) {
    const parts = p1.value.split(":")
    if (parts.length >= 2 && isHarnessCliTargetToken(parts[0]!) && parts[1] === "start") {
      return [...extraArgs, ...(afterDash ?? commandWords.slice(p1.index + 1))]
    }
  }
  if (p0 === "start" && p1 !== undefined && isHarnessCliTargetToken(p1.value)) {
    return [...extraArgs, ...(afterDash ?? commandWords.slice(p1.index + 1))]
  }
  const hasStartTarget =
    targetFlagVal !== undefined && targetFlagVal.split(",").some((s) => s.trim() === "start")
  const matchesWildcardOrAllProjects =
    projectFlagVal === undefined ||
    projectFlagVal.split(",").some((tok) => /[*?![:]/.test(tok) || isHarnessCliTargetToken(tok))
  if ((p0 === "run-many" || p0 === "affected") && hasStartTarget && matchesWildcardOrAllProjects) {
    return [...extraArgs, ...(afterDash ?? [])]
  }
  return undefined
}

const extractSegmentHarnessCliArgs = (
  unwrapped: UnwrappedWorkerWords,
): ReadonlyArray<string> | undefined => {
  const isTargetPkg =
    unwrapped.wrapperDirs.some(isHarnessCliTargetToken) ||
    (unwrapped.sawPackageRunner &&
      (hasTokenReferencingHarnessCli(unwrapped.packageTargets) ||
        unwrapped.packageTargets.some(
          (tok) => isHarnessCliTargetToken(tok) || /[*?[\]!]/.test(tok),
        )))
  const runtimeArgs = extractHarnessCliArgs(unwrapped.commandWords, isTargetPkg)
  if (runtimeArgs !== undefined) return runtimeArgs
  if (isTargetPkg && unwrapped.commandWords[0] === "start") {
    return unwrapped.commandWords.slice(1)
  }
  return extractNxHarnessCliArgs(unwrapped.commandWords)
}

const findFirstPositionalArg = (
  args: ReadonlyArray<string>,
  startIndex: number,
  valueFlags: ReadonlySet<string>,
): { readonly value: string; readonly index: number } | undefined => {
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") continue
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    const nextBoolArg = args[i + 1]
    if (
      HARNESS_OPTIONAL_BOOL_VALUE_FLAGS.has(arg) &&
      nextBoolArg !== undefined &&
      BOOLEAN_FLAG_VALUE_PATTERN.test(nextBoolArg)
    ) {
      i++
      continue
    }
    if (arg.startsWith("-")) continue
    return { value: arg, index: i }
  }
  return undefined
}

const hasWorkflowPhaseLlmOrDynamicFlag = (
  args: ReadonlyArray<string>,
  startIndex: number,
): boolean => {
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith("--phase=")) {
      const val = arg.slice("--phase=".length).trim()
      if (val === "llm" || val.includes("$")) return true
      continue
    }
    if (arg === "--phase" && i + 1 < args.length) {
      const val = args[++i]!.trim()
      if (val === "llm" || val.includes("$")) return true
    }
  }
  return false
}

const isDisallowedWorkerHarnessCliArgs = (cliArgs: ReadonlyArray<string>): boolean => {
  const sub = findFirstPositionalArg(cliArgs, 0, HARNESS_GLOBAL_VALUE_FLAGS)
  if (sub === undefined) return false
  if (sub.value.includes("$") || sub.value === "done") return true
  if (sub.value !== "workflow") return false
  const action = findFirstPositionalArg(cliArgs, sub.index + 1, HARNESS_WORKFLOW_VALUE_FLAGS)
  if (action === undefined) return false
  if (action.value.includes("$") || WORKER_BLOCKED_WORKFLOW_ACTIONS.has(action.value)) return true
  return action.value === "complete" && hasWorkflowPhaseLlmOrDynamicFlag(cliArgs, sub.index + 1)
}

const hasWorkerXargsRecursiveMatch = (
  unwrapped: UnwrappedWorkerWords,
  prevSeg: DetailedCommandSegment | undefined,
  cliArgs: ReadonlyArray<string> | undefined,
  depth: number,
): boolean => {
  const pipedTokens = prevSeg !== undefined ? extractEchoOrPrintfTokens(prevSeg) : undefined
  if (pipedTokens === undefined) {
    return prevSeg !== undefined && cliArgs !== undefined && cliArgs.length === 0
  }
  const combinedWords = applyPipedXargsTokens(unwrapped, pipedTokens)
  const combinedCliArgs = extractSegmentHarnessCliArgs({
    ...unwrapped,
    commandWords: combinedWords,
  })
  if (combinedCliArgs !== undefined && isDisallowedWorkerHarnessCliArgs(combinedCliArgs)) {
    return true
  }
  if (
    extractJsRuntimeEvalPayloads(combinedWords).some((p) =>
      isBlockedInlineJsEvalPayload(p, WORKER_BLOCKED_WORKFLOW_ACTIONS),
    )
  ) {
    return true
  }
  return extractEmbeddedCommandPayloads(combinedWords).some((payload) =>
    hasWorkerRecursiveWorkflowCommandAtDepth(payload, depth + 1),
  )
}

const hasWorkerRecursiveWorkflowCommandAtDepth = (command: string, depth: number): boolean => {
  if (depth > MAX_SUBSHELL_INSPECT_DEPTH) return true
  const norm = normalizeShellLineContinuations(command)
  if (norm.trim().length === 0) return false
  const expanded = expandCommandVariables(norm)
  if (expanded.overflowed) return true

  for (const group of splitPipedSegments(expanded.text)) {
    for (let idx = 0; idx < group.length; idx++) {
      const unwrapped = unwrapWorkerCommandWords(group[idx]!)
      const cliArgs = extractSegmentHarnessCliArgs(unwrapped)
      if (cliArgs !== undefined && isDisallowedWorkerHarnessCliArgs(cliArgs)) return true
      if (
        extractJsRuntimeEvalPayloads(unwrapped.commandWords).some((p) =>
          isBlockedInlineJsEvalPayload(p, WORKER_BLOCKED_WORKFLOW_ACTIONS),
        )
      ) {
        return true
      }
      if (
        unwrapped.sawXargs &&
        hasWorkerXargsRecursiveMatch(
          unwrapped,
          idx > 0 ? group[idx - 1] : undefined,
          cliArgs,
          depth,
        )
      ) {
        return true
      }
      const rawBin = unwrapped.commandWords[0]
      const embeddedPayloads = extractEmbeddedCommandPayloads(unwrapped.commandWords)
      if (
        rawBin !== undefined &&
        binaryBasename(rawBin) === "eval" &&
        embeddedPayloads.some(hasUnexpandedShellVariable)
      ) {
        return true
      }
      if (
        embeddedPayloads.some((payload) =>
          hasWorkerRecursiveWorkflowCommandAtDepth(payload, depth + 1),
        )
      ) {
        return true
      }
    }
  }

  return extractExecutedShellSnippets(expanded.text).some((snippet) =>
    hasWorkerRecursiveWorkflowCommandAtDepth(snippet, depth + 1),
  )
}

export const isWorkerRecursiveWorkflowCommand = (command: string): boolean =>
  hasWorkerRecursiveWorkflowCommandAtDepth(command, 0)

const matchesWorkerDaemonCredentialSegment = (
  seg: DetailedCommandSegment,
  unwrapped: UnwrappedWorkerWords,
): boolean => {
  const tokens = [
    ...seg.envAssignments,
    ...seg.commandWords,
    ...seg.wrapperDirs,
    ...unwrapped.wrapperDirs,
    ...unwrapped.commandWords,
  ]
  if (tokens.some(matchesWorkerDaemonCredentialText)) return true
  const rawBin = unwrapped.commandWords[0]
  if (rawBin !== undefined && HARNESS_INSPECT_BINARIES.has(binaryBasename(rawBin))) {
    if (
      unwrapped.commandWords
        .slice(1)
        .some((w) => !w.startsWith("-") && isProtectedDotHarnessInspectArg(w)) ||
      unwrapped.wrapperDirs.some((d) => isProtectedDotHarnessInspectArg(d))
    ) {
      return true
    }
  }
  if (unwrapped.wrapperDirs.length === 0) return false
  return unwrapped.wrapperDirs.some((dir) =>
    unwrapped.commandWords.some(
      (tok) => !tok.startsWith("-") && matchesWorkerDaemonCredentialText(path.posix.join(dir, tok)),
    ),
  )
}

const hasWorkerDaemonCredentialShellAccessAtDepth = (command: string, depth: number): boolean => {
  if (depth > MAX_SUBSHELL_INSPECT_DEPTH) return true
  const norm = normalizeShellLineContinuations(command)
  if (norm.trim().length === 0) return false
  const expanded = expandCommandVariables(norm)
  if (expanded.overflowed) return true

  const segments = extractDetailedCommandSegments(expanded.text)
  let hasXargsInspectOrExec = false
  for (const seg of segments) {
    const unwrapped = unwrapWorkerCommandWords(seg)
    if (matchesWorkerDaemonCredentialSegment(seg, unwrapped)) return true
    if (unwrapped.sawXargs) {
      const targetBin =
        unwrapped.commandWords[0] !== undefined
          ? binaryBasename(unwrapped.commandWords[0])
          : undefined
      if (
        targetBin !== undefined &&
        (HARNESS_INSPECT_BINARIES.has(targetBin) ||
          JS_RUNTIME_BINARIES.has(targetBin) ||
          SHELL_EXEC_BINARIES.has(targetBin))
      ) {
        hasXargsInspectOrExec = true
      }
    }
    if (
      extractEmbeddedCommandPayloads(unwrapped.commandWords).some((payload) =>
        hasWorkerDaemonCredentialShellAccessAtDepth(payload, depth + 1),
      )
    ) {
      return true
    }
  }
  if (
    hasXargsInspectOrExec &&
    segments.some((seg) =>
      [...seg.commandWords, ...seg.envAssignments, ...seg.wrapperDirs].some((tok) =>
        isProtectedDotHarnessInspectArg(tok),
      ),
    )
  ) {
    return true
  }
  return extractExecutedShellSnippets(expanded.text).some((snippet) =>
    hasWorkerDaemonCredentialShellAccessAtDepth(snippet, depth + 1),
  )
}

export const isWorkerDaemonCredentialShellAccess = (command: string): boolean =>
  hasWorkerDaemonCredentialShellAccessAtDepth(command, 0)
