import * as path from "node:path"
import { match } from "ts-pattern"
import { PNPM_VALUE_FLAGS } from "./policy-command-rules.js"
import { binaryBasename } from "./policy-harness-state.js"
import {
  extractDetailedCommandSegments,
  toCommandView,
  unwrapCommandSegment,
  type DetailedCommandSegment,
} from "./policy-shell-parser.js"

const wordsSet = (s: string): ReadonlySet<string> => new Set(s.split(" "))

export const MAX_SUBSHELL_INSPECT_DEPTH = 4
export const HARNESS_INSPECT_BINARIES: ReadonlySet<string> = wordsSet(
  "rg grep egrep fgrep ag ack fd find ls tree cat head tail less more bat sed awk cut strings xxd od hexdump base64 tar zip cp mv",
)
export const HARNESS_CLI_SCRIPT_PATTERN: RegExp =
  /(?:^|[\\/])harness-cli(?:[\\/]|$)|(?:^|[\\/])harness(?:\.[cm]?[jt]s)?$/
export const LOCAL_HARNESS_CLI_ENTRY_PATTERN: RegExp =
  /^(?:\.\/)?(?:src|dist)\/(?:index|hook-entry)\.[cm]?[jt]s$/

export const JS_RUNTIME_BINARIES: ReadonlySet<string> = wordsSet("node nodejs bun tsx ts-node deno")
export const JS_RUNTIME_VALUE_FLAGS: ReadonlySet<string> = wordsSet(
  "--import -r --require --loader --experimental-loader --conditions -C --env-file --env-file-if-exists --preload --tsconfig --tsconfig-override --watch-path --diagnostic-dir --redirect-warnings --title --max-old-space-size --dns-result-order --experimental-specifier-resolution --disable-proto",
)
export const DENO_VALUE_FLAGS: ReadonlySet<string> = wordsSet(
  "-c --config --import-map --lock --cert --location --seed --ext",
)
export const DENO_RUN_SUBCOMMANDS: ReadonlySet<string> = wordsSet("run test bench serve")
export const DENO_EVAL_SUBCOMMANDS: ReadonlySet<string> = wordsSet(
  "eval repl compile fmt lint check info",
)
export const SHELL_EXEC_BINARIES: ReadonlySet<string> = wordsSet("sh bash zsh dash ksh ash")
export const HARNESS_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = wordsSet(
  "--cwd --dir -C --repo-root --format --config -c --log-level",
)
export const HARNESS_WORKFLOW_VALUE_FLAGS: ReadonlySet<string> = wordsSet(
  "--level --mode --runner --max-concurrency --input --plan --run-id --run --unit --phase --repo-root --decision --cwd --dir -C --format --log-level",
)
export const HARNESS_OPTIONAL_BOOL_VALUE_FLAGS: ReadonlySet<string> = wordsSet(
  "--json --rebuild-views --cli",
)
export const BOOLEAN_FLAG_VALUE_PATTERN: RegExp = /^(?:true|false|yes|no|on|off|1|0)$/i
export const NX_RUN_VALUE_FLAGS: ReadonlySet<string> = wordsSet(
  "--configuration -c --runner --output-style --args --exclude --base --head --files --parallel",
)

const ENV_SIMPLE_FLAGS = wordsSet("-i --ignore-environment -0 --null -v --debug")
const ENV_VALUE_FLAGS = wordsSet("-u -C --unset --chdir")
const XARGS_VALUE_FLAGS = wordsSet(
  "-a --arg-file -d --delimiter -E --eof -I --replace -L --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var",
)
const PACKAGE_TARGET_FLAGS = wordsSet("--filter -F --filter-prod")
const PACKAGE_DIR_FLAGS = wordsSet("-C --dir --cwd --prefix")

export interface UnwrappedWorkerWords {
  readonly commandWords: ReadonlyArray<string>
  readonly sawPackageRunner: boolean
  readonly wrapperDirs: ReadonlyArray<string>
  readonly packageTargets: ReadonlyArray<string>
  readonly sawXargs: boolean
  readonly xargsReplaceToken: string | undefined
}

export const isHarnessCliTargetToken = (raw: string): boolean => {
  const stripped = raw
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\{|\}$/g, "")
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/^\{|\}$/g, "")
  if (stripped.length === 0) return false
  const cleaned = path.posix.normalize(stripped).replace(/\/+$/, "")
  return (
    cleaned === "harness-cli" ||
    cleaned === "@harness/harness-cli" ||
    cleaned === "@harness/cli" ||
    /(?:^|\/)apps\/harness-cli$/.test(cleaned)
  )
}

export const matchesHarnessCliScriptPath = (script: string, allowLocalEntry: boolean): boolean => {
  const normalizedScript = path.posix.normalize(script.replace(/\\/g, "/"))
  return (
    HARNESS_CLI_SCRIPT_PATTERN.test(normalizedScript) ||
    (allowLocalEntry && LOCAL_HARNESS_CLI_ENTRY_PATTERN.test(normalizedScript))
  )
}

const extractPrefixedFlagValue = (
  arg: string,
  prefixes: ReadonlyArray<string>,
): string | undefined => {
  const matchPrefix = prefixes.find((prefix) => arg.startsWith(prefix))
  return matchPrefix !== undefined ? arg.slice(matchPrefix.length) : undefined
}

const collectPackageTargetsAndDirs = (
  prefixWords: ReadonlyArray<string>,
  targetOut: Array<string>,
  dirOut: Array<string>,
): void => {
  for (let i = 0; i < prefixWords.length; i++) {
    const w = prefixWords[i]!
    const targetEq =
      w.startsWith("-F") && w.length > 2
        ? w.slice(2)
        : extractPrefixedFlagValue(w, ["--filter=", "--filter-prod="])
    if (targetEq !== undefined) {
      targetOut.push(targetEq)
      continue
    }
    if (PACKAGE_TARGET_FLAGS.has(w) && i + 1 < prefixWords.length) {
      targetOut.push(prefixWords[++i]!)
      continue
    }
    const dirEq =
      w.startsWith("-C") && w.length > 2
        ? w.slice(2)
        : extractPrefixedFlagValue(w, ["--dir=", "--cwd=", "--prefix="])
    if (dirEq !== undefined) {
      dirOut.push(dirEq)
      continue
    }
    if (PACKAGE_DIR_FLAGS.has(w) && i + 1 < prefixWords.length) {
      dirOut.push(prefixWords[++i]!)
      continue
    }
    if (PNPM_VALUE_FLAGS.has(w)) i++
  }
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
    if (arg === "-I") {
      replaceToken = words[++i]
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
    if (XARGS_VALUE_FLAGS.has(arg)) {
      i += 2
      continue
    }
    if (!arg.startsWith("-")) break
    i++
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
    const step = match(kind)
      .with("exec", () =>
        arg === "-a" ? 2 : arg === "-c" || arg === "-l" || arg.startsWith("-a") ? 1 : 0,
      )
      .with("command", () => (/^-[pvV]+$/.test(arg) ? 1 : 0))
      .exhaustive()
    if (step === 0) break
    i += step
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
    const chdirEq = extractPrefixedFlagValue(arg, ["--chdir=", "-C"])
    if (chdirEq !== undefined) {
      wrapperDirs.push(chdirEq)
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

export const unwrapWorkerCommandWords = (seg: DetailedCommandSegment): UnwrappedWorkerWords => {
  const wrapperDirs: Array<string> = [...seg.wrapperDirs]
  const packageTargets: Array<string> = []
  const prefixLimit = Math.max(0, seg.rawWords.length - seg.commandWords.length)
  collectPackageTargetsAndDirs(seg.rawWords.slice(0, prefixLimit), packageTargets, wrapperDirs)

  let words: ReadonlyArray<string> = [...seg.commandWords]
  if (words[0]?.startsWith("-") === true && seg.rawWords.some((w) => binaryBasename(w) === "env")) {
    const strippedEnv = unwrapEnvWords(["env", ...words], wrapperDirs)
    if (strippedEnv !== undefined) words = strippedEnv
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
      const splitEq = extractPrefixedFlagValue(arg, ["--split-string=", "-S"])
      if (splitEq !== undefined) {
        const p = splitEq.trim()
        return p.length > 0 ? [p] : []
      }
    }
    return []
  }
  if (!SHELL_EXEC_BINARIES.has(bin)) return []
  for (let i = 1; i < words.length; i++) {
    const arg = words[i]!
    if (arg === "--") break
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
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

export const extractJsRuntimeEvalPayloads = (
  commandWords: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const rawBin = commandWords[0]
  if (rawBin === undefined) return []
  const bin = binaryBasename(rawBin)
  if (!JS_RUNTIME_BINARIES.has(bin)) return []
  const payloads: Array<string> = []
  let inDenoEval = false
  for (let i = 1; i < commandWords.length; i++) {
    const w = commandWords[i]!
    if (inDenoEval) {
      if (w === "--") {
        if (i + 1 < commandWords.length) payloads.push(commandWords.slice(i + 1).join(" "))
        break
      }
      if (DENO_VALUE_FLAGS.has(w) || JS_RUNTIME_VALUE_FLAGS.has(w)) {
        i++
        continue
      }
      if (w.startsWith("-")) continue
      payloads.push(w)
      break
    }
    if (w === "--") break
    if (w === "--eval" || w === "--print" || /^-[ep]{1,2}$/.test(w)) {
      if (i + 1 < commandWords.length) payloads.push(commandWords[i + 1]!)
      i++
      continue
    }
    const evalEq = extractPrefixedFlagValue(w, ["--eval=", "--print="])
    if (evalEq !== undefined) {
      payloads.push(evalEq)
      continue
    }
    if (/^-[ep].+/.test(w)) {
      payloads.push(w.slice(2))
      continue
    }
    if (JS_RUNTIME_VALUE_FLAGS.has(w) || (bin === "deno" && DENO_VALUE_FLAGS.has(w))) {
      i++
      continue
    }
    if (w.startsWith("-")) continue
    if (bin === "deno" && w === "eval") {
      inDenoEval = true
      continue
    }
    break
  }
  return payloads
}

const HARNESS_REF_RE = /\bharness(?:-cli)?\b/i

export const isBlockedInlineJsEvalPayload = (
  payload: string,
  blockedActions: ReadonlySet<string>,
): boolean => {
  if (!HARNESS_REF_RE.test(payload)) return false
  if (/\bharness-cli\b/i.test(payload)) return true
  if (/daemon\.sock\b|auth-tokens\.json\b/i.test(payload)) return true
  if (/\bdone\b/.test(payload)) return true
  if (/\bworkflow\b/.test(payload)) {
    const hasBlockedWord = payload.split(/[^A-Za-z0-9_-]+/).some((w) => blockedActions.has(w))
    return hasBlockedWord || (/\bcomplete\b/.test(payload) && /\bllm\b/.test(payload))
  }
  return false
}

export const splitPipedSegments = (
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

export const extractEchoOrPrintfTokens = (
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

export const applyPipedXargsTokens = (
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
