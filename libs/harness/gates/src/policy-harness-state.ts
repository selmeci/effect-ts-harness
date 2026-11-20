import * as path from "node:path"
import {
  extractDetailedCommandSegments,
  normalizeShellLineContinuations,
  toCommandView,
  type DetailedCommandSegment,
} from "./policy-shell-parser.js"

export const PROTECTED_HARNESS_FILE_WRITE_PATTERN: RegExp =
  /(^|\/)(?:[^/]*\.git\/harness(\/|$)|[^/]*common-dir\/harness(\/|$)|(?:harness\/)?workflow-backups(\/|$)|(?:auth-tokens\.json|daemon\.(?:sock|lock)|pending-workflow-restore\.json)(\/|$))/

const PROTECTED_HARNESS_SHELL_PATH_PATTERN: RegExp =
  /(?:^|[\s=:/<>|('"`,({[])(?:[^\s;|&)<>'"`,)}\]]*(?:\.git|common-dir)\/harness(?:\/[^\s;|&)<>'"`,)}\]]*)?|(?:[^\s;|&)<>'"`,)}\]]*\/)?(?:harness\/)?workflow-backups(?:\/[^\s;|&)<>'"`,)}\]]*)?|(?:[^\s;|&)<>'"`,)}\]]*\/)?(?:auth-tokens\.json|daemon\.(?:sock|lock)|pending-workflow-restore\.json))(?=$|[\s/;|&)<>'"`,)}\]])/

const HARNESS_CMD_SUBST_PATTERN: RegExp =
  /(?:\$\([^)]*--git-(?:common-)?dir[^)]*\)|`[^`]*--git-(?:common-)?dir[^`]*`)["']?(?:\/+(?:\.\/)*harness)(?=$|[\s/;|&)<>'"`,)}\]])/

const GIT_COMMON_DIR_SUBST_PATTERN: RegExp =
  /(?:\$\([^)]*--git-(?:common-)?dir[^)]*\)|`[^`]*--git-(?:common-)?dir[^`]*`)/

const VAR_HARNESS_PATH_PATTERN: RegExp =
  /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?:[^}\s;|&)<>'"]*)\})\/+(?:\.\/)*harness(?=$|[\s/;|&)<>'"`,)}\]])/

const FIND_MUTATING_FLAG_PATTERN: RegExp =
  /^-(?:delete|exec|execdir|ok|okdir|fls|fprint0?|fprintf)$/

const HARNESS_STATE_MUTATING_BINARIES: ReadonlySet<string> = new Set(
  "rm rmdir unlink shred mv cp install tee chmod chown chgrp ln touch truncate dd mkdir mkfifo mknod flock tar rsync".split(
    " ",
  ),
)

const HARNESS_SOCKET_OR_SCRIPT_BINARIES: ReadonlySet<string> = new Set(
  "curl wget http https xh nc ncat netcat socat telnet openssl python python3 node bun tsx deno ruby perl sh bash zsh dash awk sqlite3".split(
    " ",
  ),
)

const HARNESS_REDIRECTION_OP_PATTERN: RegExp =
  /(?:&>>?|(?<![=&>-])\d*>>?(?![&>])|(?<![=&>-])\d*>&(?![\d-])|<>)(?!\s*\/dev\/null(?:\s|$))/

const binaryBasename = (word: string): string =>
  word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word

const normalizeCommonDir = (rawDir: string): string | undefined => {
  const cleaned = rawDir.replace(/\\/g, "/").trim()
  if (cleaned.length === 0) return undefined
  const norm = path.posix.normalize(cleaned).replace(/\/+$/, "")
  if (norm.length === 0 || norm === "/" || norm === ".") return undefined
  return norm
}

const collectExplicitCommonDirs = (
  segments: ReadonlyArray<DetailedCommandSegment>,
): ReadonlyArray<string> => {
  const dirs = new Set<string>()
  for (const seg of segments) {
    for (const env of seg.envAssignments) {
      if (env.startsWith("GIT_COMMON_DIR=")) {
        const norm = normalizeCommonDir(env.slice("GIT_COMMON_DIR=".length))
        if (norm !== undefined) dirs.add(norm)
      }
    }
    const words = seg.commandWords
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      if (w.startsWith("GIT_COMMON_DIR=") && words[0] === "export") {
        const norm = normalizeCommonDir(w.slice("GIT_COMMON_DIR=".length))
        if (norm !== undefined) dirs.add(norm)
        continue
      }
      if (w.startsWith("--git-common-dir=")) {
        const norm = normalizeCommonDir(w.slice("--git-common-dir=".length))
        if (norm !== undefined) dirs.add(norm)
        continue
      }
      if (w === "--git-common-dir" && i + 1 < words.length) {
        const norm = normalizeCommonDir(words[i + 1]!)
        if (norm !== undefined) dirs.add(norm)
      }
    }
  }
  return [...dirs]
}

const matchesExplicitCommonDirHarness = (
  tok: string,
  commonDirs: ReadonlyArray<string>,
): boolean => {
  if (commonDirs.length === 0) return false
  const cleaned = tok.replace(/\\/g, "/")
  if (cleaned.length === 0) return false
  const norm = path.posix.normalize(cleaned)
  return commonDirs.some((dir) => norm === `${dir}/harness` || norm.startsWith(`${dir}/harness/`))
}

const matchesProtectedHarnessTokens = (
  text: string,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
): boolean => {
  if (
    PROTECTED_HARNESS_SHELL_PATH_PATTERN.test(text) ||
    HARNESS_CMD_SUBST_PATTERN.test(text) ||
    (commandHasCommonDirSubst && VAR_HARNESS_PATH_PATTERN.test(text))
  ) {
    return true
  }
  return text.split(/[\s=:'"`(),{}[\]]+/).some((tok) => {
    if (tok.length === 0) return false
    const normTok = path.posix.normalize(tok)
    return (
      PROTECTED_HARNESS_SHELL_PATH_PATTERN.test(normTok) ||
      matchesExplicitCommonDirHarness(tok, commonDirs) ||
      matchesExplicitCommonDirHarness(normTok, commonDirs)
    )
  })
}

const rawSegmentHasProtectedTimeOutput = (
  rawWords: ReadonlyArray<string>,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
): boolean => {
  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i]!
    if (binaryBasename(w) !== "time") continue
    for (let j = i + 1; j < rawWords.length; j++) {
      const arg = rawWords[j]!
      if (arg === "--") break
      if ((arg === "-o" || arg === "--output") && j + 1 < rawWords.length) {
        if (matchesProtectedHarnessTokens(rawWords[j + 1]!, commonDirs, commandHasCommonDirSubst)) {
          return true
        }
        j++
        continue
      }
      if (arg.startsWith("--output=") || (arg.startsWith("-o") && arg.length > 2)) {
        const val = arg.startsWith("--output=") ? arg.slice("--output=".length) : arg.slice(2)
        if (matchesProtectedHarnessTokens(val, commonDirs, commandHasCommonDirSubst)) {
          return true
        }
        continue
      }
      if (!arg.startsWith("-")) break
    }
  }
  return false
}

const splitUnquotedShellSegments = (
  command: string,
  unquoted: string,
): ReadonlyArray<{ readonly cmd: string; readonly unquoted: string }> => {
  const parts: Array<{ readonly cmd: string; readonly unquoted: string }> = []
  const sepPattern = /&&|\|\||[;\n]|(?<!>)\|(?![|])|(?<![>&])&(?![>&])/g
  let start = 0
  let m = sepPattern.exec(unquoted)
  while (m !== null) {
    parts.push({
      cmd: command.slice(start, m.index),
      unquoted: unquoted.slice(start, m.index),
    })
    start = m.index + m[0].length
    m = sepPattern.exec(unquoted)
  }
  parts.push({
    cmd: command.slice(start),
    unquoted: unquoted.slice(start),
  })
  return parts
}

const matchesProtectedSegmentPaths = (
  seg: DetailedCommandSegment,
  tokenWords: ReadonlyArray<string>,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
): boolean => {
  if (matchesProtectedHarnessTokens(tokenWords.join(" "), commonDirs, commandHasCommonDirSubst)) {
    return true
  }
  if (seg.wrapperDirs.length === 0) {
    return false
  }
  if (
    matchesProtectedHarnessTokens(seg.wrapperDirs.join(" "), commonDirs, commandHasCommonDirSubst)
  ) {
    return true
  }
  return seg.wrapperDirs.some((dir) =>
    tokenWords.some(
      (tok) =>
        !tok.startsWith("-") &&
        matchesProtectedHarnessTokens(
          path.posix.join(dir, tok),
          commonDirs,
          commandHasCommonDirSubst,
        ),
    ),
  )
}

const isHarnessStateMutatingSegment = (
  seg: DetailedCommandSegment,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
): boolean => {
  if (rawSegmentHasProtectedTimeOutput(seg.rawWords, commonDirs, commandHasCommonDirSubst)) {
    return true
  }
  const rawBin = seg.commandWords[0]
  if (rawBin === undefined) {
    return false
  }
  const bin = binaryBasename(rawBin)
  const args = seg.commandWords.slice(1)
  const isMutatingOrProbingBin =
    HARNESS_STATE_MUTATING_BINARIES.has(bin) ||
    HARNESS_SOCKET_OR_SCRIPT_BINARIES.has(bin) ||
    (bin === "sed" && args.some((w) => /^-[^-]*i|^--in-place(?:=|$)/.test(w))) ||
    (bin === "find" && args.some((w) => FIND_MUTATING_FLAG_PATTERN.test(w))) ||
    (bin === "sort" && args.some((w) => /^(?:-o|--output(?:=|$))/.test(w))) ||
    (bin === "git" && args.some((w) => /^--output(?:=|$)/.test(w)))
  return (
    isMutatingOrProbingBin &&
    matchesProtectedSegmentPaths(seg, args, commonDirs, commandHasCommonDirSubst)
  )
}

const isHarnessStateAccessSegment = (
  seg: DetailedCommandSegment,
  commonDirs: ReadonlyArray<string>,
  commandHasCommonDirSubst: boolean,
): boolean => {
  if (seg.isPnpmHarness) {
    return false
  }
  const rawBin = seg.commandWords[0]
  if (rawBin === undefined) {
    return false
  }
  const bin = binaryBasename(rawBin)
  if (bin === "ls") {
    return false
  }
  if (
    bin === "find" &&
    !seg.commandWords.slice(1).some((w) => FIND_MUTATING_FLAG_PATTERN.test(w))
  ) {
    return false
  }
  return matchesProtectedSegmentPaths(
    seg,
    [...seg.envAssignments, ...seg.commandWords],
    commonDirs,
    commandHasCommonDirSubst,
  )
}

export const isHarnessStateMutationCommand = (command: string): boolean => {
  const norm = normalizeShellLineContinuations(command)
  const segments = extractDetailedCommandSegments(norm)
  const commonDirs = collectExplicitCommonDirs(segments)
  const commandHasCommonDirSubst = segments.some((seg) =>
    GIT_COMMON_DIR_SUBST_PATTERN.test([...seg.envAssignments, ...seg.commandWords].join(" ")),
  )
  if (
    segments.some((seg) => isHarnessStateMutatingSegment(seg, commonDirs, commandHasCommonDirSubst))
  ) {
    return true
  }
  const view = toCommandView(norm)
  return splitUnquotedShellSegments(norm, view.unquoted).some(
    (part) =>
      HARNESS_REDIRECTION_OP_PATTERN.test(part.unquoted) &&
      matchesProtectedHarnessTokens(
        toCommandView(part.cmd).argv,
        commonDirs,
        commandHasCommonDirSubst,
      ),
  )
}

export const isHarnessStateAccessCommand = (command: string): boolean => {
  const norm = normalizeShellLineContinuations(command)
  const segments = extractDetailedCommandSegments(norm)
  const commonDirs = collectExplicitCommonDirs(segments)
  const commandHasCommonDirSubst = segments.some((seg) =>
    GIT_COMMON_DIR_SUBST_PATTERN.test([...seg.envAssignments, ...seg.commandWords].join(" ")),
  )
  return segments.some((seg) =>
    isHarnessStateAccessSegment(seg, commonDirs, commandHasCommonDirSubst),
  )
}

export interface PolicyGuardOptions {
  readonly unitWorkerMode?: boolean | undefined
}

export type WorkerFileAccessDenyRuleId = "worker-daemon-credential-access"

export interface WorkerFileAccessResult {
  readonly verdict: "allow" | "deny"
  readonly ruleId?: WorkerFileAccessDenyRuleId | undefined
  readonly reason?: string | undefined
}

const WORKER_DAEMON_CREDENTIAL_FILE_PATTERN: RegExp =
  /(^|\/)(?:\.harness\/omnigraph-cluster(?:[*?[\]{}][^\s/]*)?(?:\/|$)|[^\s/]*auth-tokens(?:[*?[\]{}.][^\s/]*)?(?:\/|$)|(?:[^\s/]*[*?[\]{}][^\s/]*\.sock|daemon\.(?:sock|s?[*?[\]{}][^\s/]*|soc[*?[\]{}][^\s/]*))(?:\/|$))/

const HARNESS_CLI_SCRIPT_PATTERN: RegExp =
  /(?:^|[\\/])harness-cli(?:[\\/]|$)|(?:^|[\\/])harness(?:\.[cm]?[jt]s)?$/

const LOCAL_HARNESS_CLI_ENTRY_PATTERN: RegExp =
  /^(?:\.\/)?(?:src|dist)\/(?:index|hook-entry)\.[cm]?[jt]s$/

const JS_RUNTIME_BINARIES: ReadonlySet<string> = new Set(
  "node nodejs bun tsx ts-node deno".split(" "),
)

const JS_RUNTIME_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "--import -r --require --loader --experimental-loader --conditions -C --env-file --env-file-if-exists --preload --tsconfig --tsconfig-override --watch-path --diagnostic-dir --redirect-warnings --title --max-old-space-size --dns-result-order".split(
    " ",
  ),
)

const DENO_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "-c --config --import-map --lock --cert --location --seed --ext".split(" "),
)
const DENO_RUN_SUBCOMMANDS: ReadonlySet<string> = new Set(["run", "test", "bench", "serve"])
const DENO_EVAL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "eval",
  "repl",
  "compile",
  "fmt",
  "lint",
  "check",
  "info",
])

const SHELL_EXEC_BINARIES: ReadonlySet<string> = new Set("sh bash zsh dash ksh ash".split(" "))

const HARNESS_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "--cwd --dir -C --repo-root --format --config -c".split(" "),
)

const HARNESS_WORKFLOW_VALUE_FLAGS: ReadonlySet<string> = new Set(
  "--level --mode --runner --max-concurrency --input --plan --run-id --unit --phase --repo-root --decision --cwd --dir -C --format".split(
    " ",
  ),
)

const WORKER_BLOCKED_WORKFLOW_ACTIONS: ReadonlySet<string> = new Set([
  "start",
  "resume",
  "abort",
  "done",
])

const MAX_SUBSHELL_INSPECT_DEPTH = 4

const findBalancedParenEnd = (text: string, openParenIdx: number): number => {
  let depth = 1
  let quote: "'" | '"' | undefined
  for (let i = openParenIdx + 1; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === '"') quote = undefined
      continue
    }
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "(") {
      depth++
      continue
    }
    if (ch === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return text.length
}

const findClosingBacktick = (text: string, openIdx: number): number => {
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "`") return i
  }
  return text.length
}

const extractExecutedShellSnippets = (command: string): ReadonlyArray<string> => {
  const snippets: Array<string> = []
  let quote: "'" | '"' | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      continue
    }
    if (ch === "\\") {
      i++
      continue
    }
    if (quote === undefined && (ch === "'" || ch === '"')) {
      quote = ch
      continue
    }
    if (quote === '"' && ch === '"') {
      quote = undefined
      continue
    }
    if (quote === undefined && ch === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
      while (i < command.length && command[i] !== "\n") i++
      continue
    }
    if (
      (ch === "$" && command[i + 1] === "(") ||
      (quote === undefined && (ch === "<" || ch === ">") && command[i + 1] === "(")
    ) {
      const end = findBalancedParenEnd(command, i + 1)
      const inner = command.slice(i + 2, end).trim()
      if (inner.length > 0) snippets.push(inner)
      i = end
      continue
    }
    if (ch === "`") {
      const end = findClosingBacktick(command, i)
      const inner = command.slice(i + 1, end).trim()
      if (inner.length > 0) snippets.push(inner)
      i = end
    }
  }
  return snippets
}

const extractEmbeddedCommandPayloads = (seg: DetailedCommandSegment): ReadonlyArray<string> => {
  const rawBin = seg.commandWords[0]
  if (rawBin === undefined) return []
  const bin = binaryBasename(rawBin)
  if (bin === "eval") {
    const joined = seg.commandWords.slice(1).join(" ").trim()
    return joined.length > 0 ? [joined] : []
  }
  if (!SHELL_EXEC_BINARIES.has(bin)) return []
  const payloads: Array<string> = []
  for (let i = 1; i < seg.commandWords.length; i++) {
    const arg = seg.commandWords[i]!
    if (arg === "--") break
    if (arg === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
      let payloadIdx = i + 1
      while (payloadIdx < seg.commandWords.length) {
        const nextArg = seg.commandWords[payloadIdx]!
        if (nextArg === "--") {
          payloadIdx++
          break
        }
        if (nextArg.startsWith("-")) {
          payloadIdx++
          continue
        }
        break
      }
      if (payloadIdx < seg.commandWords.length) {
        const payload = seg.commandWords[payloadIdx]!.trim()
        if (payload.length > 0) payloads.push(payload)
      }
      break
    }
  }
  return payloads
}

const isHarnessCliTargetToken = (raw: string): boolean => {
  const cleaned = raw
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\{|\}$/g, "")
    .replace(/\.\.\.$/, "")
    .replace(/\/+$/, "")
  return /^(?:\.\/)?(?:apps\/)?(?:@harness\/)?harness-cli$/.test(cleaned)
}

const isHarnessCliPackageTarget = (seg: DetailedCommandSegment): boolean => {
  if (!seg.sawPackageRunner) return false
  if (seg.wrapperDirs.some(isHarnessCliTargetToken)) return true
  const limit = Math.max(0, seg.rawWords.length - seg.commandWords.length)
  for (let i = 0; i < limit; i++) {
    const w = seg.rawWords[i]!
    if ((w === "--filter" || w === "-F") && i + 1 < seg.rawWords.length) {
      if (isHarnessCliTargetToken(seg.rawWords[i + 1]!)) return true
      i++
      continue
    }
    if (w.startsWith("--filter=") && isHarnessCliTargetToken(w.slice("--filter=".length))) {
      return true
    }
    if (w.startsWith("-F") && w.length > 2 && isHarnessCliTargetToken(w.slice(2))) {
      return true
    }
  }
  return false
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
  if (bin === "harness") {
    return commandWords.slice(1)
  }
  if (!JS_RUNTIME_BINARIES.has(bin)) {
    return undefined
  }
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
    if (w.startsWith("-")) {
      continue
    }
    if (bin === "deno" && !skippedDenoSubcommand) {
      if (DENO_EVAL_SUBCOMMANDS.has(w)) {
        return undefined
      }
      if (DENO_RUN_SUBCOMMANDS.has(w)) {
        skippedDenoSubcommand = true
        continue
      }
    }
    return matchesHarnessCliScriptPath(w, allowLocalEntry) ? commandWords.slice(i + 1) : undefined
  }
  return undefined
}

const extractSegmentHarnessCliArgs = (
  seg: DetailedCommandSegment,
): ReadonlyArray<string> | undefined => {
  const isTargetPkg = isHarnessCliPackageTarget(seg)
  const runtimeArgs = extractHarnessCliArgs(seg.commandWords, isTargetPkg)
  if (runtimeArgs !== undefined) {
    return runtimeArgs
  }
  if (isTargetPkg && seg.commandWords[0] === "start") {
    return seg.commandWords.slice(1)
  }
  return undefined
}

const findFirstPositionalArg = (
  args: ReadonlyArray<string>,
  startIndex: number,
  valueFlags: ReadonlySet<string>,
): { readonly value: string; readonly index: number } | undefined => {
  let afterDoubleDash = false
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i]!
    if (afterDoubleDash) {
      return { value: arg, index: i }
    }
    if (arg === "--") {
      afterDoubleDash = true
      continue
    }
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    if (arg.startsWith("-")) {
      continue
    }
    return { value: arg, index: i }
  }
  return undefined
}

const isDisallowedWorkerHarnessCliArgs = (cliArgs: ReadonlyArray<string>): boolean => {
  const sub = findFirstPositionalArg(cliArgs, 0, HARNESS_GLOBAL_VALUE_FLAGS)
  if (sub === undefined) return false
  if (sub.value === "done") return true
  if (sub.value !== "workflow") return false
  const action = findFirstPositionalArg(cliArgs, sub.index + 1, HARNESS_WORKFLOW_VALUE_FLAGS)
  return action !== undefined && WORKER_BLOCKED_WORKFLOW_ACTIONS.has(action.value)
}

const hasWorkerRecursiveWorkflowCommandAtDepth = (command: string, depth: number): boolean => {
  if (depth > MAX_SUBSHELL_INSPECT_DEPTH) return false
  const norm = normalizeShellLineContinuations(command)
  if (norm.trim().length === 0) return false
  const segments = extractDetailedCommandSegments(norm)
  for (const seg of segments) {
    const cliArgs = extractSegmentHarnessCliArgs(seg)
    if (cliArgs !== undefined && isDisallowedWorkerHarnessCliArgs(cliArgs)) {
      return true
    }
    if (
      extractEmbeddedCommandPayloads(seg).some((payload) =>
        hasWorkerRecursiveWorkflowCommandAtDepth(payload, depth + 1),
      )
    ) {
      return true
    }
  }
  return extractExecutedShellSnippets(norm).some((snippet) =>
    hasWorkerRecursiveWorkflowCommandAtDepth(snippet, depth + 1),
  )
}

export const isWorkerRecursiveWorkflowCommand = (command: string): boolean =>
  hasWorkerRecursiveWorkflowCommandAtDepth(command, 0)

const matchesWorkerDaemonCredentialToken = (tok: string): boolean => {
  if (tok.length === 0) return false
  const normTok = path.posix.normalize(tok)
  return (
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(tok) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(normTok)
  )
}

const matchesWorkerDaemonCredentialText = (text: string): boolean => {
  const cleanedText = text.replace(/\\/g, "/")
  if (WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(cleanedText)) {
    return true
  }
  return (
    cleanedText.split(/[\s=:'"`()<>;|&,]+/).some(matchesWorkerDaemonCredentialToken) ||
    cleanedText.split(/[\s=:'"`(),{}[\]<>;|&]+/).some(matchesWorkerDaemonCredentialToken)
  )
}

const matchesWorkerDaemonCredentialSegment = (seg: DetailedCommandSegment): boolean => {
  const tokens = [...seg.envAssignments, ...seg.commandWords, ...seg.wrapperDirs]
  if (tokens.some(matchesWorkerDaemonCredentialText)) {
    return true
  }
  if (seg.wrapperDirs.length === 0) return false
  return seg.wrapperDirs.some((dir) =>
    seg.commandWords.some(
      (tok) => !tok.startsWith("-") && matchesWorkerDaemonCredentialText(path.posix.join(dir, tok)),
    ),
  )
}

const hasWorkerDaemonCredentialShellAccessAtDepth = (command: string, depth: number): boolean => {
  if (depth > MAX_SUBSHELL_INSPECT_DEPTH) return false
  const norm = normalizeShellLineContinuations(command)
  if (norm.trim().length === 0) return false
  const segments = extractDetailedCommandSegments(norm)
  for (const seg of segments) {
    if (matchesWorkerDaemonCredentialSegment(seg)) {
      return true
    }
    if (
      extractEmbeddedCommandPayloads(seg).some((payload) =>
        hasWorkerDaemonCredentialShellAccessAtDepth(payload, depth + 1),
      )
    ) {
      return true
    }
  }
  return extractExecutedShellSnippets(norm).some((snippet) =>
    hasWorkerDaemonCredentialShellAccessAtDepth(snippet, depth + 1),
  )
}

export const isWorkerDaemonCredentialShellAccess = (command: string): boolean =>
  hasWorkerDaemonCredentialShellAccessAtDepth(command, 0)

export const isWorkerDaemonCredentialFilePath = (filePath: string): boolean => {
  const rawNorm = filePath.replace(/\\/g, "/").trim()
  if (rawNorm === "") return false
  const norm = path.posix.normalize(rawNorm)
  return (
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(rawNorm) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(norm)
  )
}

export const classifyWorkerFileAccess = (
  filePath: string,
  unitWorkerMode = false,
): WorkerFileAccessResult => {
  if (!unitWorkerMode || !isWorkerDaemonCredentialFilePath(filePath)) {
    return { verdict: "allow" }
  }
  return {
    verdict: "deny",
    ruleId: "worker-daemon-credential-access",
    reason: `Worker isolation mode (HARNESS_UNIT_WORKER=1) denies access to daemon socket or auth tokens: ${filePath}`,
  }
}
