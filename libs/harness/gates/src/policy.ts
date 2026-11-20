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
  classifyWorkerFileAccess,
  isHarnessStateAccessCommand,
  isHarnessStateMutationCommand,
  isWorkerDaemonCredentialFilePath,
  isWorkerDaemonCredentialShellAccess,
  isWorkerRecursiveWorkflowCommand,
  type PolicyGuardOptions,
  type WorkerFileAccessDenyRuleId,
  type WorkerFileAccessResult,
} from "./policy-harness-state.js"
import {
  extractCommandSegments,
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

export const explainCommandDenyRule = (
  command: string,
  options?: PolicyGuardOptions,
): CommandDenyExplanation | undefined => {
  const trimmed = normalizeShellLineContinuations(command).trim()
  if (trimmed === "") {
    return undefined
  }
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
          "Worker isolation mode (HARNESS_UNIT_WORKER=1) bans recursive 'harness workflow start|resume|abort|done' and 'harness done' invocations.",
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
        "Mutating or directly probing protected harness runtime state (<git-common-dir>/harness/**, auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/, pending-workflow-restore.json) is banned by harness policy.",
    }
  }
  if (SECRET_FILE_PATTERN.test(view.argv)) {
    return {
      ruleId: "secret-file-access",
      reason:
        "Accessing or exposing secret/credential files (.env, mutation-hmac*.key, auth-tokens.json) in shell commands is banned by harness policy.",
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
  const hasUnquotedBraceExpansion = /\{[^}\s,]+,[^}\s]*\}/.test(view.unquoted)
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
    const isAllowedFilter = (p: string): boolean =>
      p.startsWith("grep ") ||
      p.startsWith("rg ") ||
      p.startsWith("head ") ||
      p.startsWith("tail ") ||
      p.startsWith("wc ") ||
      p === "wc" ||
      p.startsWith("cat ") ||
      p === "cat" ||
      p.startsWith("sort ") ||
      p === "sort"

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

export const classifyFileWrite = (
  filePath: string,
  options?: PolicyGuardOptions,
): FileWriteGuardResult => {
  if (options?.unitWorkerMode === true && isWorkerDaemonCredentialFilePath(filePath)) {
    return classifyWorkerFileAccess(filePath, true)
  }
  const rawNorm = filePath.replace(/\\/g, "/").trim()
  if (rawNorm === "") {
    return { verdict: "allow" }
  }
  const norm = path.posix.normalize(rawNorm)
  const candidates = rawNorm === norm ? [norm] : [rawNorm, norm]

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

  if (
    candidates.some(
      (p) =>
        /(^|\/)(\.env(\.[a-zA-Z0-9_-]+)*|\.dev\.vars|mutation-hmac[^/]*\.key|.*\.(pem|key))$/.test(
          p,
        ) && !/\.(example|template|sample)$/i.test(p),
    )
  ) {
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
