import * as path from "node:path"
import {
  binaryBasename,
  expandCommandVariables,
  extractExecutedShellSnippets,
  hasUnexpandedShellVariable,
} from "./policy-harness-state.js"
import {
  extractDetailedCommandSegments,
  normalizeShellLineContinuations,
  toCommandView,
  unwrapCommandSegment,
  type DetailedCommandSegment,
} from "./policy-shell-parser.js"
import {
  classifyWorkerFileAccess,
  isProtectedDotHarnessInspectArg,
  isWorkerDaemonCredentialFilePath,
  matchesWorkerDaemonCredentialText,
  type WorkerFileAccessDenyRuleId,
  type WorkerFileAccessResult,
} from "./policy-worker-paths.js"

export {
  classifyWorkerFileAccess,
  isWorkerDaemonCredentialFilePath,
  type WorkerFileAccessDenyRuleId,
  type WorkerFileAccessResult,
}

export interface PolicyGuardOptions {
  readonly unitWorkerMode?: boolean | undefined
}

export const MAX_SUBSHELL_INSPECT_DEPTH = 4
const HARNESS_INSPECT_BINARIES: ReadonlySet<string> = new Set(
  "rg grep egrep fgrep ag ack fd find ls tree cat head tail less more bat sed awk strings xxd od hexdump base64 tar zip cp mv".split(
    " ",
  ),
)

const HARNESS_CLI_SCRIPT_PATTERN: RegExp =
  /(?:^|[\\/])harness-cli(?:[\\/]|$)|(?:^|[\\/])harness(?:\.[cm]?[jt]s)?$/

const LOCAL_HARNESS_CLI_ENTRY_PATTERN: RegExp =
  /^(?:\.\/)?(?:src|dist)\/(?:index|hook-entry)\.[cm]?[jt]s$/

const wordsSet = (s: string): ReadonlySet<string> => new Set(s.split(" "))
const JS_RUNTIME_BINARIES = wordsSet("node nodejs bun tsx ts-node deno")
const JS_RUNTIME_VALUE_FLAGS = wordsSet(
  "--import -r --require --loader --experimental-loader --conditions -C --env-file --env-file-if-exists --preload --tsconfig --tsconfig-override --watch-path --diagnostic-dir --redirect-warnings --title --max-old-space-size --dns-result-order",
)
const DENO_VALUE_FLAGS = wordsSet("-c --config --import-map --lock --cert --location --seed --ext")
const DENO_RUN_SUBCOMMANDS = wordsSet("run test bench serve")
const DENO_EVAL_SUBCOMMANDS = wordsSet("eval repl compile fmt lint check info")
const SHELL_EXEC_BINARIES = wordsSet("sh bash zsh dash ksh ash")
const HARNESS_GLOBAL_VALUE_FLAGS = wordsSet("--cwd --dir -C --repo-root --format --config -c")
const HARNESS_WORKFLOW_VALUE_FLAGS = wordsSet(
  "--level --mode --runner --max-concurrency --input --plan --run-id --unit --phase --repo-root --decision --cwd --dir -C --format",
)
const NX_RUN_VALUE_FLAGS = wordsSet(
  "--configuration -c --runner --output-style --args --exclude --base --head --files --parallel",
)
const WORKER_BLOCKED_WORKFLOW_ACTIONS = wordsSet("start resume abort doctor done")
const ENV_SIMPLE_FLAGS = wordsSet("-i --ignore-environment -0 --null -v --debug")
const ENV_VALUE_FLAGS = wordsSet("-u -C --unset --chdir")
const XARGS_VALUE_FLAGS = wordsSet(
  "-a --arg-file -d --delimiter -E --eof -I --replace -L --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var",
)

const isHarnessCliTargetToken = (raw: string): boolean => {
  const cleaned = raw
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\{|\}$/g, "")
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/^\{|\}$/g, "")
    .replace(/\/+$/, "")
  return (
    cleaned === "harness-cli" ||
    cleaned === "@harness/harness-cli" ||
    cleaned === "@harness/cli" ||
    /(?:^|\/)apps\/harness-cli$/.test(cleaned)
  )
}

const collectPackageTargetsAndDirs = (
  prefixWords: ReadonlyArray<string>,
  targetOut: Array<string>,
  dirOut: Array<string>,
): void => {
  for (let i = 0; i < prefixWords.length; i++) {
    const w = prefixWords[i]!
    if ((w === "--filter" || w === "-F") && i + 1 < prefixWords.length) {
      targetOut.push(prefixWords[++i]!)
      continue
    }
    if (w.startsWith("--filter=")) {
      targetOut.push(w.slice("--filter=".length))
      continue
    }
    if (w.startsWith("-F") && w.length > 2) {
      targetOut.push(w.slice(2))
      continue
    }
    if (
      (w === "-C" || w === "--dir" || w === "--cwd" || w === "--prefix") &&
      i + 1 < prefixWords.length
    ) {
      dirOut.push(prefixWords[++i]!)
      continue
    }
    if (w.startsWith("-C") && w.length > 2) {
      dirOut.push(w.slice(2))
      continue
    }
    for (const prefix of ["--dir=", "--cwd=", "--prefix="]) {
      if (w.startsWith(prefix)) dirOut.push(w.slice(prefix.length))
    }
  }
}

interface UnwrappedWorkerWords {
  readonly commandWords: ReadonlyArray<string>
  readonly sawPackageRunner: boolean
  readonly wrapperDirs: ReadonlyArray<string>
  readonly packageTargets: ReadonlyArray<string>
  readonly sawXargs: boolean
  readonly xargsReplaceToken: string | undefined
}

const skipXargsFlags = (
  words: ReadonlyArray<string>,
): { readonly nextIndex: number; readonly replaceToken: string | undefined } => {
  let i = 1
  let replaceToken: string | undefined
  while (i < words.length) {
    const arg = words[i]!
    if (arg === "--") {
      i++
      break
    }
    if (arg === "-I" && i + 1 < words.length) {
      replaceToken = words[++i]!
      i++
      continue
    }
    if (arg === "--replace" || arg === "-i") {
      replaceToken = "{}"
      i++
      continue
    }
    if (arg.startsWith("--replace=")) {
      replaceToken = arg.slice("--replace=".length) || "{}"
      i++
      continue
    }
    if ((arg.startsWith("-I") || arg.startsWith("-i")) && arg.length > 2) {
      replaceToken = arg.slice(2)
      i++
      continue
    }
    if (XARGS_VALUE_FLAGS.has(arg) && i + 1 < words.length) {
      i += 2
      continue
    }
    if (arg.startsWith("-")) {
      i++
      continue
    }
    break
  }
  return { nextIndex: i, replaceToken }
}

const unwrapExecOrCommand = (
  words: ReadonlyArray<string>,
  kind: "exec" | "command",
): ReadonlyArray<string> => {
  let i = 1
  while (i < words.length) {
    const arg = words[i]!
    if (arg === "--") {
      i++
      break
    }
    if (kind === "exec" && arg === "-a" && i + 1 < words.length) {
      i += 2
      continue
    }
    if (
      (kind === "exec" && (arg === "-c" || arg === "-l" || arg.startsWith("-a"))) ||
      (kind === "command" && /^-[pvV]+$/.test(arg))
    ) {
      i++
      continue
    }
    break
  }
  return words.slice(i)
}

const unwrapEnvWords = (
  words: ReadonlyArray<string>,
  wrapperDirs: Array<string>,
): ReadonlyArray<string> | undefined => {
  let i = 1
  while (i < words.length) {
    const arg = words[i]!
    if (arg === "--") {
      i++
      break
    }
    if (
      arg === "-S" ||
      arg === "--split-string" ||
      arg.startsWith("--split-string=") ||
      (arg.startsWith("-S") && arg.length > 2)
    ) {
      return undefined
    }
    if (ENV_VALUE_FLAGS.has(arg) && i + 1 < words.length) {
      if (arg === "-C" || arg === "--chdir") wrapperDirs.push(words[i + 1]!)
      i += 2
      continue
    }
    if (arg.startsWith("--chdir=")) {
      wrapperDirs.push(arg.slice("--chdir=".length))
      i++
      continue
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      wrapperDirs.push(arg.slice(2))
      i++
      continue
    }
    if (
      ENV_SIMPLE_FLAGS.has(arg) ||
      arg.startsWith("--unset=") ||
      (arg.startsWith("-u") && arg.length > 2) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)
    ) {
      i++
      continue
    }
    break
  }
  if (i < words.length && words[i]!.startsWith("-")) {
    return undefined
  }
  return words.slice(i)
}

const unwrapWorkerCommandWords = (seg: DetailedCommandSegment): UnwrappedWorkerWords => {
  const wrapperDirs: Array<string> = [...seg.wrapperDirs]
  const packageTargets: Array<string> = []
  const prefixLimit = Math.max(0, seg.rawWords.length - seg.commandWords.length)
  collectPackageTargetsAndDirs(seg.rawWords.slice(0, prefixLimit), packageTargets, wrapperDirs)

  let words: ReadonlyArray<string> = [...seg.commandWords]
  if (words[0]?.startsWith("-") === true && seg.rawWords.some((w) => binaryBasename(w) === "env")) {
    const strippedEnv = unwrapEnvWords(["env", ...words], wrapperDirs)
    if (strippedEnv !== undefined && strippedEnv.length < words.length) words = strippedEnv
  }
  let sawPackageRunner = seg.sawPackageRunner
  let sawXargs = false
  let xargsReplaceToken: string | undefined

  while (words.length > 0) {
    const base = binaryBasename(words[0]!)
    if (base === "exec" || base === "command") {
      words = unwrapExecOrCommand(words, base)
      continue
    }
    if (base === "env") {
      const next = unwrapEnvWords(words, wrapperDirs)
      if (next === undefined) break
      words = next
      continue
    }
    if (base === "xargs") {
      sawXargs = true
      const skipped = skipXargsFlags(words)
      if (skipped.replaceToken !== undefined) xargsReplaceToken = skipped.replaceToken
      words = words.slice(skipped.nextIndex)
      continue
    }
    const unwrapped = unwrapCommandSegment(words)
    const consumedCount = words.length - unwrapped.commandWords.length
    if (consumedCount > 0) {
      collectPackageTargetsAndDirs(words.slice(0, consumedCount), packageTargets, wrapperDirs)
      if (unwrapped.sawPackageRunner) sawPackageRunner = true
      words = unwrapped.commandWords
      continue
    }
    break
  }

  return {
    commandWords: words,
    sawPackageRunner,
    wrapperDirs,
    packageTargets,
    sawXargs,
    xargsReplaceToken,
  }
}

export const extractEmbeddedCommandPayloads = (
  words: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const rawBin = words[0]
  if (rawBin === undefined) return []
  const bin = binaryBasename(rawBin)
  if (bin === "eval") {
    const evalArgs = words[1] === "--" ? words.slice(2) : words.slice(1)
    const joined = evalArgs.join(" ").trim()
    return joined.length > 0 ? [joined] : []
  }
  if (bin === "env") {
    for (let i = 1; i < words.length; i++) {
      const arg = words[i]!
      if (arg === "--") break
      if ((arg === "-S" || arg === "--split-string") && i + 1 < words.length) {
        const p = words[i + 1]!.trim()
        return p.length > 0 ? [p] : []
      }
      if (arg.startsWith("--split-string=")) {
        const p = arg.slice("--split-string=".length).trim()
        return p.length > 0 ? [p] : []
      }
      if (arg.startsWith("-S") && arg.length > 2) {
        const p = arg.slice(2).trim()
        return p.length > 0 ? [p] : []
      }
    }
    return []
  }
  if (!SHELL_EXEC_BINARIES.has(bin)) return []
  for (let i = 1; i < words.length; i++) {
    const arg = words[i]!
    if (arg === "--") break
    if (arg === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
      let payloadIdx = i + 1
      while (payloadIdx < words.length) {
        const nextArg = words[payloadIdx]!
        if (nextArg === "--") {
          payloadIdx++
          break
        }
        if (!nextArg.startsWith("-")) break
        payloadIdx++
      }
      const payload = words[payloadIdx]?.trim() ?? ""
      return payload.length > 0 ? [payload] : []
    }
  }
  return []
}

const matchesHarnessCliScriptPath = (script: string, allowLocalEntry: boolean): boolean =>
  HARNESS_CLI_SCRIPT_PATTERN.test(script) ||
  (allowLocalEntry && LOCAL_HARNESS_CLI_ENTRY_PATTERN.test(script.replace(/\\/g, "/")))

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
      unwrapped.packageTargets.some((tok) => isHarnessCliTargetToken(tok) || /[*?[\]!]/.test(tok)))
  const runtimeArgs = extractHarnessCliArgs(unwrapped.commandWords, isTargetPkg)
  if (runtimeArgs !== undefined) return runtimeArgs
  if (isTargetPkg && unwrapped.commandWords[0] === "start") {
    return unwrapped.commandWords.slice(1)
  }
  if (isTargetPkg && unwrapped.commandWords[0] === "run" && unwrapped.commandWords[1] === "start") {
    return unwrapped.commandWords.slice(2)
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

const splitPipedSegments = (
  command: string,
): ReadonlyArray<ReadonlyArray<DetailedCommandSegment>> => {
  const segments = extractDetailedCommandSegments(command)
  if (segments.length === 0) return []
  const { unquoted } = toCommandView(command)
  const seps: Array<string> = []
  const sepPattern = /&&|\|\||[;\n]|(?<!>)\|(?![|])|(?<![>&])&(?![>&])/g
  for (let m = sepPattern.exec(unquoted); m !== null; m = sepPattern.exec(unquoted)) {
    seps.push(m[0])
  }
  const groups: Array<Array<DetailedCommandSegment>> = [[]]
  for (let i = 0; i < segments.length; i++) {
    groups[groups.length - 1]!.push(segments[i]!)
    if (i < seps.length && seps[i] !== "|") groups.push([])
  }
  return groups
}

const extractEchoOrPrintfTokens = (
  seg: DetailedCommandSegment,
): ReadonlyArray<string> | undefined => {
  const rawBin = seg.commandWords[0]
  if (rawBin === undefined) return undefined
  const bin = binaryBasename(rawBin)
  const splitEscaped = (words: ReadonlyArray<string>): ReadonlyArray<string> =>
    words
      .flatMap((w) =>
        w
          .replace(/\\(?:n|r|t|0)/g, " ")
          .trim()
          .split(/\s+/),
      )
      .filter(Boolean)
  if (bin === "echo") {
    let i = 1
    while (i < seg.commandWords.length && /^-[neE]+$/.test(seg.commandWords[i]!)) i++
    return splitEscaped(seg.commandWords.slice(i))
  }
  if (bin === "printf") {
    const startIdx = seg.commandWords[1] === "-v" && seg.commandWords.length > 2 ? 3 : 1
    const args = seg.commandWords.slice(startIdx)
    const relevant = args.length >= 2 && args[0]!.includes("%") ? args.slice(1) : args
    return splitEscaped(relevant)
  }
  return undefined
}

const applyPipedXargsTokens = (
  unwrapped: UnwrappedWorkerWords,
  pipedTokens: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (unwrapped.xargsReplaceToken === undefined) return [...unwrapped.commandWords, ...pipedTokens]
  const tok = unwrapped.xargsReplaceToken
  const joined = pipedTokens.join(" ")
  return unwrapped.commandWords.flatMap((w) =>
    w === tok ? pipedTokens : [w.split(tok).join(joined)],
  )
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
