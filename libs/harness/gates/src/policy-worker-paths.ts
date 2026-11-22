/** Zero-dependency worker daemon/credential path matchers shared by `policy-worker-isolation.ts`
 * under the `policy-zero-dep` closure profile. */

import * as path from "node:path"

export type WorkerFileAccessDenyRuleId = "worker-daemon-credential-access"

export interface WorkerFileAccessResult {
  readonly verdict: "allow" | "deny"
  readonly ruleId?: WorkerFileAccessDenyRuleId | undefined
  readonly reason?: string | undefined
}

const WORKER_DAEMON_CREDENTIAL_FILE_PATTERN: RegExp =
  /(^|\/)(?:\.harness\/(?:omnigraph-cluster|omnigraph[*?[\]{}][^\s/]*|\*\/(?:auth|omnigraph|\*)[^\s/]*|\*\*?\/\*?(?:auth|omnigraph|tokens|sock)[^\s/]*)(?:\/|$)|[^\s/]*omnigraph-cluster(?:[*?[\]{}.][^\s/]*)?(?:\/|$)|[^\s/]*auth[*?[\]{}.-]*tokens(?:[*?[\]{}.][^\s/]*)?(?:\/|$)|(?:[^\s/]*[*?[\]{}][^\s/]*\.sock|daemon\.(?:sock(?:[*?[\]{}][^\s/]*)?|s?[*?[\]{}][^\s/]*|soc[*?[\]{}][^\s/]*))(?:\/|$))/

const deobfuscateWorkerToken = (tok: string): string =>
  tok.replace(/\\(.)/g, "$1").replace(/\[([^\]!^-])\]/g, "$1")

export const isProtectedDotHarnessInspectArg = (tok: string): boolean => {
  const norm = path.posix
    .normalize(deobfuscateWorkerToken(tok).replace(/\\/g, "/"))
    .replace(/\/+$/, "")
  if (
    norm === ".harness" ||
    norm.endsWith("/.harness") ||
    norm === ".git" ||
    norm.endsWith("/.git")
  ) {
    return true
  }
  const harnessSub = /(?:^|\/)\.harness\/([^/]+)(?:\/|$)/.exec(norm)
  if (harnessSub !== null) {
    const seg = harnessSub[1]!
    if (seg.startsWith("omnigraph") || (seg !== "workflow-worktrees" && /[*?[\]{}]/.test(seg))) {
      return true
    }
  }
  const gitSub = /(?:^|\/)\.git\/([^/]+)(?:\/|$)/.exec(norm)
  if (gitSub !== null) {
    const seg = gitSub[1]!
    if (seg === "harness" || seg === "worktrees" || /[*?[\]{}]/.test(seg)) {
      return true
    }
  }
  return false
}

const matchesWorkerDaemonCredentialToken = (tok: string): boolean => {
  if (tok.length === 0) return false
  const stripped = deobfuscateWorkerToken(tok)
  const normTok = path.posix.normalize(stripped)
  return (
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(tok) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(stripped) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(normTok)
  )
}

export const matchesWorkerDaemonCredentialText = (text: string): boolean => {
  const cleanedText = text.replace(/\\/g, "/")
  if (WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(cleanedText)) return true
  return (
    cleanedText.split(/[\s=:'"`()<>;|&,]+/).some(matchesWorkerDaemonCredentialToken) ||
    cleanedText.split(/[\s=:'"`(),{}[\]<>;|&]+/).some(matchesWorkerDaemonCredentialToken)
  )
}

export const isWorkerDaemonCredentialFilePath = (filePath: string): boolean => {
  const rawNorm = filePath.replace(/\\/g, "/").trim()
  if (rawNorm === "") return false
  const stripped = deobfuscateWorkerToken(rawNorm)
  const norm = path.posix.normalize(stripped)
  return (
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(rawNorm) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(stripped) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(norm) ||
    isProtectedDotHarnessInspectArg(norm)
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
