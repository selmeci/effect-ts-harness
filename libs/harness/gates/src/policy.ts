/** Deterministic guard policy. `classifyCommand` never calls the decision model:
 * "escalate" means "deterministic rules left this open" (mvp.md, safety guard row);
 * "ask" means "always confirm with the human first" (alchemy deploy/destroy/profile,
 * matching Alchemy's own advice to confirm every deploy). */

import * as path from "node:path"
import {
  ALLOWLIST,
  ASKLIST,
  CD_COMMAND_BANNED_REASON,
  DENYLIST,
  DESTRUCTIVE_ARGUMENT_PATTERNS,
  FILE_REDIRECTION_PATTERN,
  GIT_DISCARD_PATTERNS,
  GIT_FORCE_PUSH_PATTERN,
  GIT_PACK_EXEC_OVERRIDE_PATTERNS,
  GUARD_SELF_INVOCATION_PATTERN,
  INTERACTIVE_NX_BANNED_REASON,
  MAX_CLASSIFY_COMMAND_LENGTH,
  OBFUSCATION_PATTERNS,
  SECRET_FILE_PATTERN,
  SHELL_OPERATORS,
  SKIP_NX_CACHE_BANNED_REASON,
  containsToken,
  hasUnquotedAdjacentBracketGlob,
  isCommandAllowed,
  matchesAny,
  splitByUnquotedOperator,
  stripSafeLeadingEnvVars,
  type GuardPatternRule,
  type GuardVerdict,
} from "./policy-command-rules.js"
import {
  PROTECTED_HARNESS_FILE_WRITE_PATTERN,
  expandCommandVariables,
  extractExecutedShellSnippets,
  isHarnessStateAccessCommand,
  isHarnessStateMutationCommand,
} from "./policy-harness-state.js"
import {
  MAX_SUBSHELL_INSPECT_DEPTH,
  classifyWorkerFileAccess,
  extractEmbeddedCommandPayloads,
  isWorkerDaemonCredentialFilePath,
  isWorkerDaemonCredentialShellAccess,
  isWorkerRecursiveWorkflowCommand,
  type PolicyGuardOptions,
  type WorkerFileAccessDenyRuleId,
  type WorkerFileAccessResult,
} from "./policy-worker-isolation.js"
import {
  extractCommandSegments,
  extractDetailedCommandSegments,
  hasUnquotedBackgroundOperator,
  normalizeShellLineContinuations,
  toCommandView,
  type CommandView,
  type UnwrappedSegment,
} from "./policy-shell-parser.js"

export {
  ALLOWLIST,
  ASKLIST,
  CD_COMMAND_BANNED_REASON,
  DENYLIST,
  DESTRUCTIVE_ARGUMENT_PATTERNS,
  FILE_REDIRECTION_PATTERN,
  GIT_DISCARD_PATTERNS,
  GUARD_SELF_INVOCATION_PATTERN,
  INTERACTIVE_NX_BANNED_REASON,
  MAX_SUBSHELL_INSPECT_DEPTH,
  OBFUSCATION_PATTERNS,
  SECRET_FILE_PATTERN,
  SHELL_OPERATORS,
  SKIP_NX_CACHE_BANNED_REASON,
  classifyWorkerFileAccess,
  isCommandAllowed,
  isHarnessStateMutationCommand,
  isWorkerDaemonCredentialShellAccess,
  isWorkerRecursiveWorkflowCommand,
  toCommandView,
  type CommandView,
  type GuardPatternRule,
  type GuardVerdict,
  type PolicyGuardOptions,
  type WorkerFileAccessDenyRuleId,
  type WorkerFileAccessResult,
}

export const isCdCommand = (trimmed: string): boolean =>
  extractCommandSegments(trimmed).some((seg) => seg.commandWords[0] === "cd")

const SKIP_NX_CACHE_ARG_PATTERN = /^--(?:skip-nx-cache|skipNxCache)(?:=(?!false$).*)?$/
const SKIP_NX_CACHE_ENV_PATTERN = /^(?:NX_SKIP_NX_CACHE|NX_DISABLE_NX_CACHE)=(?:true|1)$/

const segmentHasSkipNxCache = (seg: UnwrappedSegment): boolean => {
  if (seg.envAssignments.some((env) => SKIP_NX_CACHE_ENV_PATTERN.test(env))) {
    return true
  }
  const bin = seg.commandWords[0]
  if (bin === undefined) {
    return false
  }
  const isTarget =
    bin === "nx" ||
    bin.endsWith("/nx") ||
    (seg.sawPackageRunner && (bin === "verify" || bin === "verify:all"))
  if (!isTarget) {
    return false
  }
  return seg.commandWords.slice(1).some((arg) => SKIP_NX_CACHE_ARG_PATTERN.test(arg))
}

export const isSkipNxCacheCommand = (command: string): boolean =>
  extractCommandSegments(command).some(
    (seg) =>
      segmentHasSkipNxCache(seg) && !seg.envAssignments.includes("HARNESS_ALLOW_SKIP_NX_CACHE=1"),
  )

export const isSkipNxCacheOverrideCommand = (command: string): boolean =>
  extractCommandSegments(command).some(
    (seg) =>
      segmentHasSkipNxCache(seg) && seg.envAssignments.includes("HARNESS_ALLOW_SKIP_NX_CACHE=1"),
  )

export const CLEF_SYSTEMONE_ONLY_BANNED_REASON =
  "clef (clef-flash) is a TypeSafe System One structured decision model, NOT a generative text/chat model — /api/generate, /api/chat, /v1/chat/completions, /v1/completions, and 'ollama run clef*' do not exist for System One models and return HTTP errors. Use DecisionModel.decide (@effect/ai-typesafe TypeSafeDecisionModel) or POST http://localhost:11434/v1/systemone ({ model: 'clef-flash', state, questions }), or run 'pnpm harness doctor' to warm/verify the model."

const IGNORED_CLEF_GUARD_BINARIES: ReadonlySet<string> = new Set("grep rg git gh vitest".split(" "))

const CLEF_HTTP_OR_SCRIPT_BINARIES: ReadonlySet<string> = new Set(
  "curl wget http https xh fetch python python3 node bun tsx deno".split(" "),
)

const CLEF_MODEL_NAME_PATTERN = /\bclef(?:-flash)?\b/i
const CLEF_INVALID_ENDPOINT_PATTERN =
  /(?:\/api\/(?:generate|chat|embeddings|embed)|\/v1\/(?:chat\/completions|completions|responses|embeddings))\b/i

export const isInvalidClefEndpointCommand = (command: string): boolean =>
  extractCommandSegments(command).some((seg) => {
    const rawBin = seg.commandWords[0]
    if (rawBin === undefined) {
      return false
    }
    const bin = rawBin.includes("/") ? rawBin.slice(rawBin.lastIndexOf("/") + 1) : rawBin
    if (IGNORED_CLEF_GUARD_BINARIES.has(bin)) {
      return false
    }
    if (
      bin === "ollama" &&
      seg.commandWords[1] === "run" &&
      seg.commandWords.slice(2).some((w) => /^clef(?:-|:|$)/i.test(w))
    ) {
      return true
    }
    if (CLEF_HTTP_OR_SCRIPT_BINARIES.has(bin)) {
      const segText = seg.commandWords.join(" ")
      return CLEF_MODEL_NAME_PATTERN.test(segText) && CLEF_INVALID_ENDPOINT_PATTERN.test(segText)
    }
    return false
  })

export const isInteractiveNxCommand = (command: string): boolean =>
  extractCommandSegments(command).some((seg) => {
    const bin = seg.commandWords[0]
    if (bin !== "nx" && !(bin?.endsWith("/nx") ?? false)) {
      return false
    }
    const nonFlagWords = seg.commandWords.slice(1).filter((tok) => !tok.startsWith("-"))
    const isShowSubcommand =
      nonFlagWords[0] === "show" ||
      (seg.commandWords[1]?.startsWith("-") === true && nonFlagWords.includes("show"))
    if (!isShowSubcommand) {
      return false
    }
    const hasNonInteractiveEnv = seg.envAssignments.some(
      (env) => env === "CI=true" || env === "CI=1" || env === "NX_INTERACTIVE=false",
    )
    return !hasNonInteractiveEnv
  })

export type CommandDenyRuleId =
  | "cd-command-banned"
  | "interactive-nx-banned"
  | "skip-nx-cache-banned"
  | "invalid-clef-endpoint"
  | "denylist-token"
  | "git-force-push"
  | "git-pack-exec-override"
  | "worker-recursive-workflow-command"
  | "worker-daemon-credential-access"
  | "harness-state-mutation"
  | "secret-file-access"
  | "guard-self-invocation"

export interface CommandDenyExplanation {
  readonly ruleId: CommandDenyRuleId
  readonly reason: string
}

const extractEchoInlineCommand = (snippet: string): string | undefined => {
  const seg = extractDetailedCommandSegments(snippet)[0]
  if (seg === undefined || seg.commandWords.length < 2) return undefined
  const rawBin = seg.commandWords[0]!
  const bin = rawBin.includes("/") ? rawBin.slice(rawBin.lastIndexOf("/") + 1) : rawBin
  if (bin !== "echo") return undefined
  let i = 1
  while (i < seg.commandWords.length && /^-[neE]+$/.test(seg.commandWords[i]!)) {
    i++
  }
  const rest = seg.commandWords.slice(i).join(" ").trim()
  return rest.length > 0 ? rest : undefined
}

const explainDirectCommandDenyRule = (
  trimmed: string,
  expandedText: string,
  options?: PolicyGuardOptions,
): CommandDenyExplanation | undefined => {
  if (isCdCommand(trimmed)) {
    return { ruleId: "cd-command-banned", reason: CD_COMMAND_BANNED_REASON }
  }
  if (isInteractiveNxCommand(trimmed)) {
    return { ruleId: "interactive-nx-banned", reason: INTERACTIVE_NX_BANNED_REASON }
  }
  if (isSkipNxCacheCommand(trimmed)) {
    return { ruleId: "skip-nx-cache-banned", reason: SKIP_NX_CACHE_BANNED_REASON }
  }
  if (isInvalidClefEndpointCommand(trimmed)) {
    return { ruleId: "invalid-clef-endpoint", reason: CLEF_SYSTEMONE_ONLY_BANNED_REASON }
  }
  const view = toCommandView(trimmed)
  const matchedDeny = DENYLIST.find((entry) => containsToken(view.argv, entry.token))
  if (matchedDeny !== undefined) {
    return {
      ruleId: "denylist-token",
      reason: `Command contains banned token '${matchedDeny.token}' (${matchedDeny.reason}).`,
    }
  }
  if (GIT_FORCE_PUSH_PATTERN.test(view.argv)) {
    return {
      ruleId: "git-force-push",
      reason: "Force-pushing with '--force' or '-f' is banned by harness policy.",
    }
  }
  if (GIT_PACK_EXEC_OVERRIDE_PATTERNS.some((pattern) => pattern.test(view.argv))) {
    return {
      ruleId: "git-pack-exec-override",
      reason:
        "Git remote/transfer command with custom upload-pack/receive-pack/exec or ext:: helper is banned by harness policy.",
    }
  }
  if (options?.unitWorkerMode === true) {
    if (isWorkerRecursiveWorkflowCommand(trimmed)) {
      return {
        ruleId: "worker-recursive-workflow-command",
        reason:
          "Worker isolation mode (HARNESS_UNIT_WORKER=1) bans recursive 'harness workflow start|resume|abort|doctor|complete --phase llm' and 'harness done' invocations.",
      }
    }
    if (isWorkerDaemonCredentialShellAccess(trimmed)) {
      return {
        ruleId: "worker-daemon-credential-access",
        reason:
          "Worker isolation mode (HARNESS_UNIT_WORKER=1) bans shell access to daemon.sock or auth-tokens.json.",
      }
    }
  }
  if (isHarnessStateMutationCommand(trimmed)) {
    return {
      ruleId: "harness-state-mutation",
      reason:
        "Mutating or directly probing protected harness runtime state (<git-common-dir>/harness/**, auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/, pending-workflow-restore.json, stamps, caches, repos/**, oxlint policy) is banned by harness policy.",
    }
  }
  const expandedArgv = toCommandView(expandedText).argv
  if (
    SECRET_FILE_PATTERN.test(view.argv) ||
    SECRET_FILE_PATTERN.test(view.argv.replace(/\\(.)/g, "$1")) ||
    SECRET_FILE_PATTERN.test(expandedArgv) ||
    SECRET_FILE_PATTERN.test(expandedArgv.replace(/\\(.)/g, "$1"))
  ) {
    return {
      ruleId: "secret-file-access",
      reason:
        "Accessing or exposing secret/credential files (.env, .dev.vars, mutation-hmac*.key, auth-tokens.json) in shell commands is banned by harness policy.",
    }
  }
  if (isHarnessStateAccessCommand(trimmed)) {
    return {
      ruleId: "harness-state-mutation",
      reason:
        "Reading or inspecting protected harness runtime state (<git-common-dir>/harness/**, auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/, pending-workflow-restore.json) is banned by harness policy.",
    }
  }
  if (GUARD_SELF_INVOCATION_PATTERN.test(view.argv)) {
    return {
      ruleId: "guard-self-invocation",
      reason: "Invoking 'harness guard' from an agent shell command is banned by harness policy.",
    }
  }
  return undefined
}

const explainCommandDenyRuleAtDepth = (
  command: string,
  options: PolicyGuardOptions | undefined,
  depth: number,
): CommandDenyExplanation | undefined => {
  if (depth > MAX_SUBSHELL_INSPECT_DEPTH) {
    return {
      ruleId: "harness-state-mutation",
      reason: "Command exceeded maximum subshell/wrapper nesting inspection depth.",
    }
  }
  const trimmed = normalizeShellLineContinuations(command).trim()
  if (trimmed === "") {
    return undefined
  }
  const expanded = expandCommandVariables(trimmed)
  if (expanded.overflowed) {
    return {
      ruleId: "harness-state-mutation",
      reason: "Command variable expansion exceeded maximum inspection size.",
    }
  }
  const direct = explainDirectCommandDenyRule(trimmed, expanded.text, options)
  if (direct !== undefined) {
    return direct
  }

  const candidateTexts = expanded.text === trimmed ? [trimmed] : [trimmed, expanded.text]
  for (const candidate of candidateTexts) {
    for (const seg of extractDetailedCommandSegments(candidate)) {
      for (const payload of extractEmbeddedCommandPayloads(seg.commandWords)) {
        const sub = explainCommandDenyRuleAtDepth(payload, options, depth + 1)
        if (sub !== undefined) return sub
      }
    }
    for (const snippet of extractExecutedShellSnippets(candidate)) {
      const sub = explainCommandDenyRuleAtDepth(snippet, options, depth + 1)
      if (sub !== undefined) return sub
      const unwrappedEcho = extractEchoInlineCommand(snippet)
      if (unwrappedEcho !== undefined && isHarnessStateMutationCommand(unwrappedEcho)) {
        const echoSub = explainCommandDenyRuleAtDepth(unwrappedEcho, options, depth + 1)
        if (echoSub !== undefined) return echoSub
      }
    }
  }
  return undefined
}

export const explainCommandDenyRule = (
  command: string,
  options?: PolicyGuardOptions,
): CommandDenyExplanation | undefined => explainCommandDenyRuleAtDepth(command, options, 0)

export const explainCommandDenyReason = (
  command: string,
  options?: PolicyGuardOptions,
): string | undefined => explainCommandDenyRule(command, options)?.reason

/** Rule order is load-bearing (harness:ADR-0003): deny → ask → escalate → allow.
 * Every rule that removes the automatic `allow` must run before the prefix allowlist. */
export const classifyCommand = (command: string, options?: PolicyGuardOptions): GuardVerdict => {
  if (command.length > MAX_CLASSIFY_COMMAND_LENGTH) {
    return "ask"
  }
  const norm = normalizeShellLineContinuations(command)
  const trimmed = norm.trim()
  if (trimmed === "") {
    return "escalate"
  }
  if (explainCommandDenyRule(trimmed, options) !== undefined) {
    return "deny"
  }
  if (isSkipNxCacheOverrideCommand(trimmed)) {
    return "ask"
  }
  const view = toCommandView(norm)
  const hasBgOp = hasUnquotedBackgroundOperator(view.unquoted)
  const hasUnquotedBraceExpansion = /\{[^}\s,]*,[^}\s]*\}/.test(view.unquoted)
  if (
    ASKLIST.some((token) => containsToken(view.argv, token)) ||
    matchesAny(view.argv, GIT_DISCARD_PATTERNS)
  ) {
    return "ask"
  }
  if (
    view.unclosedQuote ||
    view.hasDoubleQuotedSubstitution ||
    view.hasAnsiCQuote ||
    matchesAny(view.argv, DESTRUCTIVE_ARGUMENT_PATTERNS) ||
    FILE_REDIRECTION_PATTERN.test(view.unquoted) ||
    matchesAny(norm, OBFUSCATION_PATTERNS) ||
    hasUnquotedAdjacentBracketGlob(norm, view.unquoted) ||
    hasUnquotedBraceExpansion ||
    /\$\(|`|<\(|>\(/.test(view.unquoted)
  ) {
    return "escalate"
  }
  if (hasBgOp || SHELL_OPERATORS.some((op) => view.unquoted.includes(op))) {
    const isAllowedFilter = (p: string): boolean => {
      const argv = toCommandView(p).argv
      return (
        argv === "grep" ||
        argv.startsWith("grep ") ||
        ((argv === "rg" || argv.startsWith("rg ")) &&
          !/(?:^|\s)--(?:pre|pre-glob|hostname-bin)(?:=|\s|$)/.test(argv)) ||
        argv === "head" ||
        argv.startsWith("head ") ||
        argv === "tail" ||
        argv.startsWith("tail ") ||
        argv === "wc" ||
        argv.startsWith("wc ") ||
        argv === "cat" ||
        argv.startsWith("cat ") ||
        ((argv === "sort" || argv.startsWith("sort ")) &&
          !/(?:^|\s)(?:-[^\s-]*o|--output(?:=|\s|$))/.test(argv))
      )
    }

    const isAllowedPipedSegment = (segCmd: string, segUnquoted: string): boolean => {
      if (!segUnquoted.includes("|") || segUnquoted.includes("||")) {
        return false
      }
      const parts = splitByUnquotedOperator(segCmd, segUnquoted, "|")
      return (
        parts.length >= 2 &&
        isCommandAllowed(parts[0]!.cmd) &&
        parts.slice(1).every((p) => isAllowedFilter(p.cmd))
      )
    }

    if (
      !hasBgOp &&
      view.unquoted.includes("|") &&
      !view.unquoted.includes("||") &&
      !view.unquoted.includes("&&") &&
      !view.unquoted.includes(";") &&
      !view.unquoted.includes("\n")
    ) {
      if (isAllowedPipedSegment(norm, view.unquoted)) {
        return "allow"
      }
    }
    if (
      !hasBgOp &&
      view.unquoted.includes("&&") &&
      !view.unquoted.includes("||") &&
      !view.unquoted.includes(";") &&
      !view.unquoted.includes("\n")
    ) {
      const parts = splitByUnquotedOperator(norm, view.unquoted, "&&")
      if (
        parts.length >= 2 &&
        parts.every(
          (p) =>
            p.cmd.length > 0 &&
            (isCommandAllowed(p.cmd) || isAllowedPipedSegment(p.cmd, p.unquoted)) &&
            !/^\s*git\s+(?:add|commit|push)\b/.test(stripSafeLeadingEnvVars(p.cmd)),
        )
      ) {
        return "allow"
      }
    }
    return "escalate"
  }
  return isCommandAllowed(norm) ? "allow" : "escalate"
}

export type FileWriteDenyRuleId =
  | "readonly-subtree"
  | "verify-stamp"
  | "mutate-stamp"
  | "harness-cache"
  | "harness-common-dir-state"
  | "secret-file"
  | "worker-daemon-credential-access"

export interface FileWriteGuardResult {
  readonly verdict: "allow" | "deny" | "ask"
  readonly ruleId?: FileWriteDenyRuleId | undefined
  readonly reason?: string | undefined
}

export type FileReadDenyRuleId =
  | "harness-common-dir-state"
  | "secret-file"
  | "worker-daemon-credential-access"

export interface FileReadGuardResult {
  readonly verdict: "allow" | "deny"
  readonly ruleId?: FileReadDenyRuleId | undefined
  readonly reason?: string | undefined
}

const expandBracketBody = (body: string): ReadonlyArray<string> | undefined => {
  if (body.length === 0 || body.startsWith("!") || body.startsWith("^")) {
    return undefined
  }
  const chars: Array<string> = []
  for (let i = 0; i < body.length;) {
    if (i + 2 < body.length && body[i + 1] === "-") {
      const start = body.charCodeAt(i)
      const end = body.charCodeAt(i + 2)
      if (end < start || end - start + 1 > 8) {
        return undefined
      }
      for (let code = start; code <= end; code++) {
        chars.push(String.fromCharCode(code))
      }
      i += 3
      continue
    }
    chars.push(body[i]!)
    i += 1
  }
  const unique = [...new Set(chars)]
  return unique.length > 0 && unique.length <= 8 ? unique : undefined
}

const isBracketSensitivePath = (s: string): boolean =>
  /(?:^|\/)\./.test(s) ||
  /(?:^|\/)\[[^\]]*\](?:env|en\?|e\?v|nv|dev|git|harness|cache|oxlint)/i.test(s) ||
  /(?:^|\/)(?:repos|tools\/oxlint|common-dir|harness|workflow-backups|mutation|auth|daemon|pending-workflow-restore)/i.test(
    s,
  ) ||
  /\.[^/]*\[[^\]]*\][^/]*$/.test(s)

const stripGlobCharClasses = (
  p: string,
): { readonly candidates: ReadonlyArray<string>; readonly truncated: boolean } => {
  const unescaped = p.replace(/\\(.)/g, "$1").replace(/\[([^\]!^-])\]/g, "$1")
  const out: Array<string> = []
  let truncated = false
  let queue: Array<string> = [unescaped]
  for (let pass = 0; pass < 3; pass++) {
    const nextQueue: Array<string> = []
    for (const item of queue) {
      const m = /\[([^\]/\s]+)\]/.exec(item)
      if (m === null) {
        nextQueue.push(item)
        continue
      }
      const alts = expandBracketBody(m[1]!)
      if (alts === undefined) {
        if (isBracketSensitivePath(item)) truncated = true
        nextQueue.push(item)
        continue
      }
      const prefix = item.slice(0, m.index)
      const suffix = item.slice(m.index + m[0].length)
      for (const ch of alts) {
        if (nextQueue.length >= 32) {
          if (isBracketSensitivePath(item)) truncated = true
          break
        }
        nextQueue.push(`${prefix}${ch}${suffix}`.replace(/\[([^\]!^-])\]/g, "$1"))
      }
    }
    queue = nextQueue
  }
  for (const item of queue) {
    if (/\[[^\]/\s]+\]/.test(item) && isBracketSensitivePath(item)) {
      truncated = true
    }
    if (!out.includes(item)) out.push(item)
  }
  const wildcarded = unescaped.replace(/\[[^\]/\s]+\]/g, "?")
  if (!out.includes(wildcarded)) out.push(wildcarded)
  return { candidates: out, truncated }
}

const expandGlobObfuscationCandidates = (
  raw: string,
): { readonly candidates: ReadonlyArray<string>; readonly truncated: boolean } => {
  const out: Array<string> = []
  let truncated = false
  const pushUnique = (val: string): void => {
    if (val.length > 0 && !out.includes(val)) out.push(val)
  }
  const queue: Array<string> = [raw]
  for (let pass = 0; pass < 2; pass++) {
    const nextQueue: Array<string> = []
    for (const item of queue) {
      const brace = /\{([^{}]{1,128})\}/.exec(item)
      if (brace === null || !brace[1]!.includes(",")) {
        nextQueue.push(item)
        continue
      }
      const rawAlts = brace[1]!.split(",")
      if (rawAlts.length > 8) {
        truncated = true
      }
      const alts = rawAlts.slice(0, 8)
      const prefix = item.slice(0, brace.index)
      const suffix = item.slice(brace.index + brace[0].length)
      for (const alt of alts) {
        if (nextQueue.length >= 16) {
          truncated = true
          break
        }
        nextQueue.push(`${prefix}${alt}${suffix}`)
      }
    }
    queue.splice(0, queue.length, ...nextQueue)
  }
  for (const item of queue) {
    if (/\{[^{}]*,[^{}]*\}/.test(item)) {
      truncated = true
    }
    pushUnique(item)
    const strippedResult = stripGlobCharClasses(item)
    if (strippedResult.truncated) truncated = true
    for (const stripped of strippedResult.candidates) {
      pushUnique(stripped)
      pushUnique(path.posix.normalize(stripped))
    }
  }
  return { candidates: out, truncated }
}

const normalizeFilePathCandidates = (
  filePath: string,
): { readonly candidates: ReadonlyArray<string>; readonly truncated: boolean } => {
  const trimmed = filePath.trim()
  if (trimmed === "") {
    return { candidates: [], truncated: false }
  }
  const rawNorm = trimmed.replace(/\\/g, "/")
  const norm = path.posix.normalize(rawNorm)
  const bases = new Set<string>([trimmed, rawNorm, norm])
  const out: Array<string> = []
  let truncated = false
  for (const base of bases) {
    const expanded = expandGlobObfuscationCandidates(base)
    if (expanded.truncated) truncated = true
    for (const variant of expanded.candidates) {
      if (!out.includes(variant)) out.push(variant)
    }
  }
  return { candidates: out, truncated }
}

const isSecretFileWritePath = (p: string): boolean =>
  /(^|\/)(\.(?:env\??|en\?|e\?v)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|\.(?:dev\.vars\??|dev\.var\?)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|mutation-hma[c*?][^/]*(?:\.ke?[y*?]?|\*|\?|\]|\})|.*\.(pem|key))$/.test(
    p,
  ) && !/\.(example|template|sample)$/i.test(p)

const isSecretFileReadPath = (p: string): boolean =>
  (/(^|\/)(\.(?:env\??|en\?|e\?v)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|\.(?:dev\.vars\??|dev\.var\?)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|mutation-hma[c*?][^/]*(?:\.ke?[y*?]?|\*|\?|\]|\})|.*\.(?:pem|key))$/.test(
    p,
  ) ||
    /(^|\/)\.cache\/effect-harness(\/|$)/.test(p)) &&
  !/\.(example|template|sample)$/i.test(p)

const findWorkerCredentialCandidate = (
  filePath: string,
  candidates: ReadonlyArray<string>,
  options?: PolicyGuardOptions,
): string | undefined => {
  if (options?.unitWorkerMode !== true) return undefined
  if (isWorkerDaemonCredentialFilePath(filePath)) return filePath
  return candidates.find(isWorkerDaemonCredentialFilePath)
}

export const classifyFileRead = (
  filePath: string,
  options?: PolicyGuardOptions,
): FileReadGuardResult => {
  const { candidates, truncated } = normalizeFilePathCandidates(filePath)
  if (truncated) {
    return {
      verdict: "deny",
      ruleId: "harness-common-dir-state",
      reason: `Glob expansion complexity limit exceeded; failing closed on file read: ${filePath}`,
    }
  }
  if (candidates.length === 0) {
    return { verdict: "allow" }
  }
  const workerTarget = findWorkerCredentialCandidate(filePath, candidates, options)
  if (workerTarget !== undefined) {
    return classifyWorkerFileAccess(workerTarget, true)
  }
  if (candidates.some((p) => PROTECTED_HARNESS_FILE_WRITE_PATTERN.test(p))) {
    return {
      verdict: "deny",
      ruleId: "harness-common-dir-state",
      reason: `Direct read/inspection of protected harness runtime state is forbidden: ${filePath}`,
    }
  }
  if (candidates.some(isSecretFileReadPath)) {
    return {
      verdict: "deny",
      ruleId: "secret-file",
      reason: `Secret or credential file read is forbidden by harness guard: ${filePath}`,
    }
  }
  return { verdict: "allow" }
}

export const classifyFileWrite = (
  filePath: string,
  options?: PolicyGuardOptions,
): FileWriteGuardResult => {
  const { candidates, truncated } = normalizeFilePathCandidates(filePath)
  if (truncated) {
    return {
      verdict: "deny",
      ruleId: "harness-common-dir-state",
      reason: `Glob expansion complexity limit exceeded; failing closed on file write: ${filePath}`,
    }
  }
  if (candidates.length === 0) {
    return { verdict: "allow" }
  }
  const workerTarget = findWorkerCredentialCandidate(filePath, candidates, options)
  if (workerTarget !== undefined) {
    return classifyWorkerFileAccess(workerTarget, true)
  }

  if (candidates.some((p) => /(^|\/)repos\/(effect|alchemy)(\/|$)/.test(p))) {
    return {
      verdict: "deny",
      ruleId: "readonly-subtree",
      reason: `Protected read-only subtree cannot be modified: ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)\.harness\/(worktrees\/[^/]+\/)?verify-stamp\.json$/.test(p))) {
    return {
      verdict: "deny",
      ruleId: "verify-stamp",
      reason: `Direct modification of verify-stamp.json is forbidden (stamp forgery protection): ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)\.harness\/(worktrees\/[^/]+\/)?mutate-stamp\.json$/.test(p))) {
    return {
      verdict: "deny",
      ruleId: "mutate-stamp",
      reason: `Direct modification of mutate-stamp.json is forbidden (stamp forgery protection): ${filePath}`,
    }
  }

  if (
    candidates.some((p) =>
      /(^|\/)\.harness\/(worktrees\/[^/]+\/)?(cache\/mutation-cache-v\d+\.(?:json(?:\.corrupt)?|corrupt)|session-preinvocation-cache\.json|last-done\.json|graph-snapshot\.json|graph-head\.json)$/.test(
        p,
      ),
    )
  ) {
    return {
      verdict: "deny",
      ruleId: "harness-cache",
      reason: `Direct modification of harness cache file is forbidden: ${filePath}`,
    }
  }

  if (candidates.some((p) => PROTECTED_HARNESS_FILE_WRITE_PATTERN.test(p))) {
    return {
      verdict: "deny",
      ruleId: "harness-common-dir-state",
      reason: `Direct modification of protected harness runtime state is forbidden: ${filePath}`,
    }
  }

  if (candidates.some(isSecretFileWritePath)) {
    return {
      verdict: "deny",
      ruleId: "secret-file",
      reason: `Secret or credential file modification is forbidden by harness guard: ${filePath}`,
    }
  }

  if (candidates.some((p) => /(^|\/)(\.oxlintrc\.json|tools\/oxlint\/.*|.*\.cedar)$/.test(p))) {
    return {
      verdict: "ask",
      reason: `Modifying harness governance/linter policy requires human confirmation: ${filePath}`,
    }
  }

  return { verdict: "allow" }
}
