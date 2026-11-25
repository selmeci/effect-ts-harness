/** Deterministic guard policy. `classifyCommand` never calls the decision model:
 * "escalate" means "deterministic rules left this open" (mvp.md, safety guard row);
 * "ask" means "always confirm with the human first" (alchemy deploy/destroy/profile,
 * matching Alchemy's own advice to confirm every deploy). */

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
  isSafeReadOnlyXargsSegment,
  matchesAny,
  splitByUnquotedOperator,
  stripSafeLeadingEnvVars,
  type GuardPatternRule,
  type GuardVerdict,
} from "./policy-command-rules.js"
import {
  isAllowableStrippedHeredocCommand,
  isGuardSelfInvocationCommand,
  normalizeHeredocAwareContinuations,
  stripSafeDataHeredocBodies,
  stripSafeDataHeredocBodiesWithMeta,
} from "./policy-heredoc.js"
import {
  PROTECTED_HARNESS_FILE_WRITE_PATTERN,
  expandCommandVariables,
  extractExecutedShellSnippets,
  isHarnessStateAccessCommand,
  isHarnessStateMutationCommand,
} from "./policy-harness-state.js"
import {
  MAX_SUBSHELL_INSPECT_DEPTH,
  WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS,
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
  toCommandView,
  type CommandView,
  type UnwrappedSegment,
} from "./policy-shell-parser.js"
import {
  matchesGovernanceAskGlob,
  matchesProtectedStateGlob,
  matchesReadonlySubtreeGlob,
  matchesSecretFileGlob,
  normalizeFilePathCandidates as normalizeFilePathCandidatesShared,
} from "./policy-worker-paths.js"

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
  WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS,
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

const CASE_INSENSITIVE_GLOB_FLAG_PATTERN = /(?:^|\s)(?:-iname|-ipath|-iwholename|--iglob)(?:=|\s|$)/
const UNQUOTED_BRACE_EXPANSION_PATTERN = /\{[^}\s]*(?:,|\.\.)[^}\s]*\}/

const isHandledByUnquotedEscalate = (
  tok: string,
  rawCommand: string,
  unquoted: string,
): boolean => {
  if (/[*?]/.test(tok)) return false
  const bracketGroups = tok.match(/\[[^\]\s]+\]/g) ?? []
  const braceGroups = (tok.match(/\{[^}\s]+\}/g) ?? []).filter((g) => /(?:,|\.\.)/.test(g))
  if (bracketGroups.length === 0 && braceGroups.length === 0) return false
  if (
    bracketGroups.length > 0 &&
    (!bracketGroups.every((g) => unquoted.includes(g)) ||
      !hasUnquotedAdjacentBracketGlob(rawCommand, unquoted))
  ) {
    return false
  }
  if (
    braceGroups.length > 0 &&
    (!braceGroups.every((g) => unquoted.includes(g)) ||
      !UNQUOTED_BRACE_EXPANSION_PATTERN.test(unquoted))
  ) {
    return false
  }
  return true
}

const extractCommandGlobSubTokens = (
  argv: string,
  rawCommand: string,
  unquoted: string,
): ReadonlyArray<string> => {
  const rawTokens = argv.trim().split(/\s+/)
  const hasCaseInsensitive = CASE_INSENSITIVE_GLOB_FLAG_PATTERN.test(argv)
  const out: Array<string> = []
  const seen = new Set<string>()
  const pushSub = (val: string): void => {
    if (val === "" || !/[*?[\]{}]/.test(val)) return
    if (isHandledByUnquotedEscalate(val, rawCommand, unquoted)) return
    const add = (candidate: string): void => {
      if (candidate !== "" && !seen.has(candidate)) {
        seen.add(candidate)
        out.push(candidate)
      }
    }
    add(val)
    if (val.includes("\\")) {
      add(val.replace(/\\(.)/g, "$1"))
    }
    if (hasCaseInsensitive) {
      add(val.toLowerCase())
      if (val.includes("\\")) {
        add(val.replace(/\\(.)/g, "$1").toLowerCase())
      }
    }
  }
  for (const tok of rawTokens) {
    if (tok === "") continue
    pushSub(tok)
    const eqIdx = tok.indexOf("=")
    if (eqIdx > 0) {
      pushSub(tok.slice(eqIdx + 1))
    }
    if (/^-[gf].+/.test(tok)) {
      pushSub(tok.slice(2))
    }
  }
  return out
}

const argvMatchesSecretGlobToken = (argv: string, rawCommand: string, unquoted: string): boolean =>
  extractCommandGlobSubTokens(argv, rawCommand, unquoted).some((sub) =>
    normalizeFilePathCandidates(sub).candidates.some(isSecretFileReadPath),
  )

const argvMatchesProtectedStateGlobToken = (
  argv: string,
  rawCommand: string,
  unquoted: string,
): boolean =>
  extractCommandGlobSubTokens(argv, rawCommand, unquoted).some((sub) =>
    normalizeFilePathCandidates(sub).candidates.some(
      (p) => PROTECTED_HARNESS_FILE_WRITE_PATTERN.test(p) || matchesProtectedStateGlob(p),
    ),
  )

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
  const heredocStripped = stripSafeDataHeredocBodies(trimmed)
  if (options?.unitWorkerMode === true) {
    if (isWorkerRecursiveWorkflowCommand(trimmed)) {
      return {
        ruleId: "worker-recursive-workflow-command",
        reason: `Worker isolation mode (HARNESS_UNIT_WORKER=1) bans recursive 'harness workflow ${WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join("|")}' and 'harness done' invocations.`,
      }
    }
    if (isWorkerDaemonCredentialShellAccess(heredocStripped)) {
      return {
        ruleId: "worker-daemon-credential-access",
        reason:
          "Worker isolation mode (HARNESS_UNIT_WORKER=1) bans shell access to daemon.sock or auth-tokens.json.",
      }
    }
  }
  if (isHarnessStateMutationCommand(heredocStripped)) {
    return {
      ruleId: "harness-state-mutation",
      reason:
        "Mutating or directly probing protected harness runtime state (<git-common-dir>/harness/**, auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/, pending-workflow-restore.json, stamps, caches, repos/**, oxlint policy) is banned by harness policy.",
    }
  }
  const heredocExp =
    heredocStripped === trimmed
      ? { text: expandedText, overflowed: false }
      : expandCommandVariables(heredocStripped)
  if (heredocExp.overflowed) {
    return {
      ruleId: "harness-state-mutation",
      reason: "Command variable expansion exceeded maximum inspection size.",
    }
  }
  const hView = heredocStripped === trimmed ? view : toCommandView(heredocStripped)
  const hExpText = heredocExp.text
  const hExpView = hExpText === heredocStripped ? hView : toCommandView(hExpText)
  if (
    SECRET_FILE_PATTERN.test(hView.argv) ||
    SECRET_FILE_PATTERN.test(hView.argv.replace(/\\(.)/g, "$1")) ||
    SECRET_FILE_PATTERN.test(hExpView.argv) ||
    SECRET_FILE_PATTERN.test(hExpView.argv.replace(/\\(.)/g, "$1")) ||
    argvMatchesSecretGlobToken(hView.argv, heredocStripped, hView.unquoted) ||
    argvMatchesSecretGlobToken(hExpView.argv, hExpText, hExpView.unquoted)
  ) {
    return {
      ruleId: "secret-file-access",
      reason:
        "Accessing or exposing secret/credential files (.env, .dev.vars, mutation-hmac*.key, auth-tokens.json) in shell commands is banned by harness policy.",
    }
  }
  if (
    isHarnessStateAccessCommand(heredocStripped) ||
    argvMatchesProtectedStateGlobToken(hView.argv, heredocStripped, hView.unquoted) ||
    argvMatchesProtectedStateGlobToken(hExpView.argv, hExpText, hExpView.unquoted)
  ) {
    return {
      ruleId: "harness-state-mutation",
      reason:
        "Reading or inspecting protected harness runtime state (<git-common-dir>/harness/**, auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/, pending-workflow-restore.json) is banned by harness policy.",
    }
  }
  if (isGuardSelfInvocationCommand(trimmed)) {
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
  const trimmed = normalizeHeredocAwareContinuations(command).trim()
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

  const heredocStripped = stripSafeDataHeredocBodies(trimmed)
  const candidateTexts = new Set<string>([trimmed, expanded.text])
  if (heredocStripped !== trimmed) {
    candidateTexts.add(heredocStripped)
    const strippedExp = expandCommandVariables(heredocStripped)
    if (!strippedExp.overflowed) candidateTexts.add(strippedExp.text)
  }
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

const SIMPLE_PIPE_FILTER_BINS: ReadonlySet<string> = new Set([
  "grep",
  "head",
  "tail",
  "wc",
  "cat",
  "cut",
])

const isAllowedPipeFilter = (p: string): boolean => {
  if (isSafeReadOnlyXargsSegment(p)) return true
  const argv = toCommandView(p).argv
  const head = argv.split(" ", 1)[0] ?? ""
  if (SIMPLE_PIPE_FILTER_BINS.has(head)) return true
  if (head === "rg") return !/(?:^|\s)--(?:pre|pre-glob|hostname-bin)(?:=|\s|$)/.test(argv)
  if (head === "sort") return !/(?:^|\s)(?:-[^\s-]*o|--output(?:=|\s|$))/.test(argv)
  return false
}

const isAllowedPipedSegment = (segCmd: string, segUnquoted: string): boolean => {
  if (!segUnquoted.includes("|") || segUnquoted.includes("||")) {
    return false
  }
  const parts = splitByUnquotedOperator(segCmd, segUnquoted, "|")
  return (
    parts.length >= 2 &&
    isCommandAllowed(parts[0]!.cmd) &&
    parts.slice(1).every((p) => isAllowedPipeFilter(p.cmd))
  )
}

/** Rule order is load-bearing (harness:ADR-0003): deny → ask → escalate → allow.
 * Every rule that removes the automatic `allow` must run before the prefix allowlist. */
export const classifyCommand = (command: string, options?: PolicyGuardOptions): GuardVerdict => {
  if (command.length > MAX_CLASSIFY_COMMAND_LENGTH) {
    return "ask"
  }
  const norm = normalizeHeredocAwareContinuations(command)
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
  const hasUnquotedBraceExpansion = /\{[^}\s]*(?:,|\.\.)[^}\s]*\}/.test(view.unquoted)
  if (
    ASKLIST.some((token) => containsToken(view.argv, token)) ||
    matchesAny(view.argv, GIT_DISCARD_PATTERNS)
  ) {
    return "ask"
  }
  if (matchesAny(view.argv, DESTRUCTIVE_ARGUMENT_PATTERNS)) {
    return "escalate"
  }
  const heredocMeta = stripSafeDataHeredocBodiesWithMeta(norm)
  if (heredocMeta.strippedCount > 0) {
    return isAllowableStrippedHeredocCommand(heredocMeta, isAllowedPipedSegment)
      ? "allow"
      : "escalate"
  }
  if (
    view.unclosedQuote ||
    view.hasDoubleQuotedSubstitution ||
    view.hasAnsiCQuote ||
    FILE_REDIRECTION_PATTERN.test(view.unquoted) ||
    matchesAny(norm, OBFUSCATION_PATTERNS) ||
    hasUnquotedAdjacentBracketGlob(norm, view.unquoted) ||
    hasUnquotedBraceExpansion ||
    /\$\(|`|<\(|>\(/.test(view.unquoted)
  ) {
    return "escalate"
  }
  if (hasBgOp || SHELL_OPERATORS.some((op) => view.unquoted.includes(op))) {
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
  readonly verdict: "allow" | "deny" | "ask"
  readonly ruleId?: FileReadDenyRuleId | undefined
  readonly reason?: string | undefined
}

const normalizeFilePathCandidates = normalizeFilePathCandidatesShared

const isSecretFileWritePath = (p: string): boolean =>
  (/(^|\/)(\.(?:env\??|en\?|e\?v|\?nv)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|\.(?:dev\.vars\??|dev\.var\?)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|mutation-hma[c*?][^/]*(?:\.ke?[y*?]?|\*|\?|\]|\})|.*\.(pem|key))$/.test(
    p,
  ) ||
    matchesSecretFileGlob(p)) &&
  !/\.(example|template|sample)$/i.test(p)

const isSecretFileReadPath = (p: string): boolean =>
  (/(^|\/)(\.(?:env\??|en\?|e\?v|\?nv)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|\.(?:dev\.vars\??|dev\.var\?)(?:\.[a-zA-Z0-9_*?-]+)*\*?\??|mutation-hma[c*?][^/]*(?:\.ke?[y*?]?|\*|\?|\]|\})|.*\.(?:pem|key))$/.test(
    p,
  ) ||
    /(^|\/)\.cache\/effect-harness(\/|$)/.test(p) ||
    matchesSecretFileGlob(p)) &&
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
  if (candidates.length === 0) {
    return { verdict: "allow" }
  }
  const workerTarget = findWorkerCredentialCandidate(filePath, candidates, options)
  if (workerTarget !== undefined) {
    return classifyWorkerFileAccess(workerTarget, true)
  }
  if (
    candidates.some(
      (p) => PROTECTED_HARNESS_FILE_WRITE_PATTERN.test(p) || matchesProtectedStateGlob(p),
    )
  ) {
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
  if (truncated) {
    return {
      verdict: "ask",
      reason: `Glob expansion complexity limit exceeded; human confirmation required for file read: ${filePath}`,
    }
  }
  return { verdict: "allow" }
}

export const classifyFileWrite = (
  filePath: string,
  options?: PolicyGuardOptions,
): FileWriteGuardResult => {
  const { candidates, truncated } = normalizeFilePathCandidates(filePath)
  if (candidates.length === 0) {
    return { verdict: "allow" }
  }
  const workerTarget = findWorkerCredentialCandidate(filePath, candidates, options)
  if (workerTarget !== undefined) {
    return classifyWorkerFileAccess(workerTarget, true)
  }

  if (
    candidates.some(
      (p) => /(^|\/)repos\/(effect|alchemy)(\/|$)/.test(p) || matchesReadonlySubtreeGlob(p),
    )
  ) {
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
      /(^|\/)\.harness\/(worktrees\/[^/]+\/)?(cache\/mutation-(?:cache|test-timings)-v(?:\d+|[^/*?[\]{}]*[*?[\]{}][^/]*)\.(?:json(?:\.corrupt)?|corrupt)|session-preinvocation-cache\.json|last-done\.json|graph-snapshot\.json|graph-head\.json)$/.test(
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

  if (
    candidates.some(
      (p) => PROTECTED_HARNESS_FILE_WRITE_PATTERN.test(p) || matchesProtectedStateGlob(p),
    )
  ) {
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

  if (
    candidates.some(
      (p) =>
        /(^|\/)(\.oxlintrc\.json|tools\/oxlint\/.*|.*\.cedar)$/.test(p) ||
        matchesGovernanceAskGlob(p),
    )
  ) {
    return {
      verdict: "ask",
      reason: `Modifying harness governance/linter policy requires human confirmation: ${filePath}`,
    }
  }

  if (truncated) {
    return {
      verdict: "ask",
      reason: `Glob expansion complexity limit exceeded; human confirmation required for file write: ${filePath}`,
    }
  }

  return { verdict: "allow" }
}
