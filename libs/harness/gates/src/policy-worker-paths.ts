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

type GlobSegmentToken = ((ch: string) => boolean) | undefined

const matchesCharClassExpr = (expr: string, ch: string): boolean => {
  const negated = expr[0] === "!" || expr[0] === "^"
  const body = (negated ? expr.slice(1) : expr).toLowerCase()
  const lowerCh = ch.toLowerCase()
  let matched = false
  for (let i = 0; i < body.length;) {
    if (i + 2 < body.length && body[i + 1] === "-") {
      if (lowerCh >= body[i]! && lowerCh <= body[i + 2]!) matched = true
      i += 3
      continue
    }
    if (body[i] === lowerCh) matched = true
    i += 1
  }
  return negated ? !matched : matched
}

export const matchesGlobSegment = (patternSeg: string, probeSeg: string): boolean => {
  const tokens: Array<GlobSegmentToken> = []
  for (let i = 0; i < patternSeg.length;) {
    const ch = patternSeg[i]!
    if (ch === "*") {
      tokens.push(undefined)
      i += 1
      continue
    }
    if (ch === "?") {
      tokens.push(() => true)
      i += 1
      continue
    }
    if (ch === "[") {
      const end = patternSeg.indexOf("]", i + 1)
      if (end > i + 1) {
        const expr = patternSeg.slice(i + 1, end)
        tokens.push((c) => matchesCharClassExpr(expr, c))
        i = end + 1
        continue
      }
    }
    const lower = ch.toLowerCase()
    tokens.push((c) => c.toLowerCase() === lower)
    i += 1
  }
  let dp = Array<boolean>(probeSeg.length + 1).fill(false)
  dp[0] = true
  for (const tok of tokens) {
    const next = Array<boolean>(probeSeg.length + 1).fill(false)
    if (tok === undefined) {
      let seen = false
      for (let j = 0; j <= probeSeg.length; j++) {
        if (dp[j]!) seen = true
        next[j] = seen
      }
    } else {
      for (let j = 0; j < probeSeg.length; j++) {
        if (dp[j]! && tok(probeSeg[j]!)) {
          next[j + 1] = true
        }
      }
    }
    dp = next
  }
  return dp[probeSeg.length] === true
}

export interface SensitiveGlobProbe {
  readonly segments: ReadonlyArray<string>
  readonly minSegLiterals: ReadonlyArray<readonly [string, number]>
  readonly prefixOk: boolean
}

export const countLiteralStemChars = (pat: string, stem: string): number => {
  const cleaned = pat
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[*?]/g, "")
    .toLowerCase()
  let hits = 0
  for (const ch of stem.toLowerCase()) {
    if (cleaned.includes(ch)) hits += 1
  }
  return hits
}

export const matchesSensitiveGlobProbes = (
  normPath: string,
  probes: ReadonlyArray<SensitiveGlobProbe>,
): boolean => {
  if (!/[*?[\]]/.test(normPath)) return false
  const segs = normPath.split("/").filter((s) => s.length > 0 && s !== ".")
  return probes.some((probe) => {
    const n = segs.length
    const m = probe.segments.length
    for (let pi = 0; pi <= n - m; pi++) {
      if (!probe.prefixOk && pi + m !== n) continue
      let ok = true
      for (let j = 0; j < m; j++) {
        const segPat = segs[pi + j]!
        const [litStem, minLit] = probe.minSegLiterals[j]!
        if (
          !matchesGlobSegment(segPat, probe.segments[j]!) ||
          countLiteralStemChars(segPat, litStem) < minLit
        ) {
          ok = false
          break
        }
      }
      if (ok) return true
    }
    return false
  })
}

export const parseBraceRangeAlternatives = (body: string): ReadonlyArray<string> | undefined => {
  if (body.includes(",")) return body.split(",")
  const letterMatch = /^(?:([a-z])\.\.([a-z])|([A-Z])\.\.([A-Z]))$/.exec(body)
  if (letterMatch !== null) {
    const s = (letterMatch[1] ?? letterMatch[3])!.charCodeAt(0)
    const e = (letterMatch[2] ?? letterMatch[4])!.charCodeAt(0)
    const step = s <= e ? 1 : -1
    const alts: Array<string> = []
    for (let c = s; (step > 0 ? c <= e : c >= e) && alts.length < 64; c += step) {
      alts.push(String.fromCharCode(c))
    }
    return alts
  }
  const numMatch = /^(-?\d{1,3})\.\.(-?\d{1,3})$/.exec(body)
  if (numMatch !== null) {
    const s = Number.parseInt(numMatch[1]!, 10)
    const e = Number.parseInt(numMatch[2]!, 10)
    const step = s <= e ? 1 : -1
    const alts: Array<string> = []
    for (let n = s; (step > 0 ? n <= e : n >= e) && alts.length < 64; n += step) {
      alts.push(String(n))
    }
    return alts
  }
  return undefined
}

const sliceDotPrefixOutsideBrackets = (seg: string, keepInternalDots: number): string => {
  let inBracket = false
  let dots = 0
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!
    if (ch === "[") {
      inBracket = true
      continue
    }
    if (ch === "]") {
      inBracket = false
      continue
    }
    if (ch === "." && !inBracket && i > 0) {
      dots += 1
      if (dots === keepInternalDots) return seg.slice(0, i)
    }
  }
  return seg
}

const MUTATION_HMAC_GLOB_PROBE: SensitiveGlobProbe = {
  segments: ["mutation-hmac.key"],
  minSegLiterals: [["mutationhmac", 5]],
  prefixOk: false,
}

const NON_HMAC_SECRET_FILE_GLOB_PROBES: ReadonlyArray<SensitiveGlobProbe> = [
  { segments: [".env"], minSegLiterals: [["env", 2]], prefixOk: false },
  { segments: [".dev.vars"], minSegLiterals: [["devvars", 4]], prefixOk: false },
  { segments: ["auth-tokens.json"], minSegLiterals: [["authtokens", 4]], prefixOk: false },
  { segments: ["auth_tokens.json"], minSegLiterals: [["authtokens", 4]], prefixOk: false },
  {
    segments: [".cache", "effect-harness"],
    minSegLiterals: [
      ["cache", 3],
      ["effectharness", 5],
    ],
    prefixOk: true,
  },
]

const isSafeNonSecretWorkspaceDirPrefix = (dirSegs: ReadonlyArray<string>): boolean =>
  dirSegs.length >= 1 &&
  dirSegs.every(
    (seg) =>
      !seg.startsWith(".") &&
      seg !== "~" &&
      !/[*?[\]{}]/.test(seg) &&
      !/^(?:secrets?|credentials?|auth|tokens?|common-dir|workflow-backups)$/i.test(seg),
  )

const hasMutationHmacOrKeyIndicator = (lastSeg: string): boolean =>
  /(?:hmac|h[a-z*?[\]]*ac|mutation[-_]?h|key|pem)/i.test(lastSeg)

export const matchesSecretFileGlob = (p: string): boolean => {
  if (!/[*?[\]]/.test(p) || /\.(example|template|sample)$/i.test(p)) return false
  if (matchesSensitiveGlobProbes(p, NON_HMAC_SECRET_FILE_GLOB_PROBES)) return true
  const segs = p.split("/").filter((s) => s.length > 0 && s !== ".")
  const dirSegs = segs.slice(0, -1)
  const segTail = segs[segs.length - 1] ?? ""
  const slashIdx = p.lastIndexOf("/")
  const dirPart = slashIdx === -1 ? "" : p.slice(0, slashIdx + 1)
  const lastSeg = slashIdx === -1 ? p : p.slice(slashIdx + 1)
  const lastDot = lastSeg.lastIndexOf(".")
  const extPat = lastDot > 0 ? lastSeg.slice(lastDot + 1) : undefined
  const hasWildcardKeyOrPemExt =
    extPat !== undefined &&
    /[*?[\]]/.test(extPat) &&
    (matchesGlobSegment(extPat, "key") || matchesGlobSegment(extPat, "pem"))
  const allowNonHmacSubdir =
    isSafeNonSecretWorkspaceDirPrefix(dirSegs) &&
    !hasMutationHmacOrKeyIndicator(segTail) &&
    !hasWildcardKeyOrPemExt
  if (!allowNonHmacSubdir && matchesSensitiveGlobProbes(p, [MUTATION_HMAC_GLOB_PROBE])) {
    return true
  }
  const envStem = sliceDotPrefixOutsideBrackets(lastSeg, 1)
  if (
    envStem !== lastSeg &&
    matchesSensitiveGlobProbes(`${dirPart}${envStem}`, [NON_HMAC_SECRET_FILE_GLOB_PROBES[0]!])
  ) {
    return true
  }
  const devStem = sliceDotPrefixOutsideBrackets(lastSeg, 2)
  if (
    devStem !== lastSeg &&
    matchesSensitiveGlobProbes(`${dirPart}${devStem}`, [NON_HMAC_SECRET_FILE_GLOB_PROBES[1]!])
  ) {
    return true
  }
  if (extPat !== undefined && /[*?[\]]/.test(extPat)) {
    if (
      (matchesGlobSegment(extPat, "key") && countLiteralStemChars(extPat, "key") >= 2) ||
      (matchesGlobSegment(extPat, "pem") && countLiteralStemChars(extPat, "pem") >= 2)
    ) {
      return true
    }
  }
  return false
}

const PROTECTED_STATE_GLOB_PROBES: ReadonlyArray<SensitiveGlobProbe> = [
  { segments: ["daemon.sock"], minSegLiterals: [["daemon", 3]], prefixOk: false },
  { segments: ["daemon.lock"], minSegLiterals: [["daemon", 3]], prefixOk: false },
  { segments: ["workflow-backups"], minSegLiterals: [["workflowbackups", 6]], prefixOk: true },
  {
    segments: ["common-dir", "harness"],
    minSegLiterals: [
      ["commondir", 4],
      ["harness", 3],
    ],
    prefixOk: true,
  },
  {
    segments: [".git", "harness"],
    minSegLiterals: [
      ["git", 2],
      ["harness", 3],
    ],
    prefixOk: true,
  },
  {
    segments: ["pending-workflow-restore.json"],
    minSegLiterals: [["pendingworkflowrestore", 7]],
    prefixOk: false,
  },
  { segments: ["omnigraph-cluster"], minSegLiterals: [["omnigraphcluster", 5]], prefixOk: true },
  { segments: ["auth-tokens.json"], minSegLiterals: [["authtokens", 4]], prefixOk: false },
]

export const matchesProtectedStateGlob = (p: string): boolean =>
  matchesSensitiveGlobProbes(p, PROTECTED_STATE_GLOB_PROBES)

const READONLY_SUBTREE_GLOB_PROBES: ReadonlyArray<SensitiveGlobProbe> = [
  {
    segments: ["repos", "effect"],
    minSegLiterals: [
      ["repos", 2],
      ["effect", 3],
    ],
    prefixOk: true,
  },
  {
    segments: ["repos", "alchemy"],
    minSegLiterals: [
      ["repos", 2],
      ["alchemy", 3],
    ],
    prefixOk: true,
  },
]

export const matchesReadonlySubtreeGlob = (p: string): boolean =>
  matchesSensitiveGlobProbes(p, READONLY_SUBTREE_GLOB_PROBES)

const GOVERNANCE_ASK_GLOB_PROBES: ReadonlyArray<SensitiveGlobProbe> = [
  {
    segments: ["tools", "oxlint"],
    minSegLiterals: [
      ["tools", 3],
      ["oxlint", 3],
    ],
    prefixOk: true,
  },
  { segments: [".oxlintrc.json"], minSegLiterals: [["oxlintrc", 4]], prefixOk: false },
]

export const matchesGovernanceAskGlob = (p: string): boolean =>
  matchesSensitiveGlobProbes(p, GOVERNANCE_ASK_GLOB_PROBES)

const SENSITIVE_WORKER_GLOB_PROBES: ReadonlyArray<SensitiveGlobProbe> = [
  { segments: ["omnigraph-cluster"], minSegLiterals: [["omnigraphcluster", 5]], prefixOk: true },
  { segments: ["auth-tokens.json"], minSegLiterals: [["authtokens", 4]], prefixOk: false },
  { segments: ["auth_tokens.json"], minSegLiterals: [["authtokens", 4]], prefixOk: false },
  { segments: ["daemon.sock"], minSegLiterals: [["daemon", 3]], prefixOk: false },
  { segments: ["daemon.lock"], minSegLiterals: [["daemon", 3]], prefixOk: false },
  {
    segments: [".git", "harness"],
    minSegLiterals: [
      ["git", 2],
      ["harness", 3],
    ],
    prefixOk: true,
  },
  {
    segments: [".git", "worktrees"],
    minSegLiterals: [
      ["git", 2],
      ["worktrees", 4],
    ],
    prefixOk: true,
  },
  {
    segments: [".harness", "omnigraph-cluster"],
    minSegLiterals: [
      ["harness", 3],
      ["omnigraphcluster", 5],
    ],
    prefixOk: true,
  },
]

export const isWorkerDaemonCredentialFilePath = (filePath: string): boolean => {
  const rawNorm = filePath.replace(/\\/g, "/").trim()
  if (rawNorm === "") return false
  const stripped = deobfuscateWorkerToken(rawNorm)
  const norm = path.posix.normalize(stripped)
  return (
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(rawNorm) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(stripped) ||
    WORKER_DAEMON_CREDENTIAL_FILE_PATTERN.test(norm) ||
    isProtectedDotHarnessInspectArg(norm) ||
    matchesSensitiveGlobProbes(norm, SENSITIVE_WORKER_GLOB_PROBES)
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
  /(?:^|\/)(?:repos|common-dir|workflow-backups|mutation-h|auth[-_]?tok|omnigraph-cluster|daemon\.|pending-workflow-restore)/i.test(
    s,
  ) ||
  /\.[^/]*\[[^\]]*\][^/]*$/.test(s) ||
  matchesSecretFileGlob(s) ||
  matchesProtectedStateGlob(s) ||
  matchesReadonlySubtreeGlob(s)

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

const emitExpandedTailVariants = (
  candidate: string,
  braceDepth: number,
  out: Array<string>,
  pushUnique: (val: string) => void,
): boolean => {
  if (out.length >= 2048) return true
  const nestedBrace = braceDepth < 2 ? /\{([^{}]{1,4096})\}/.exec(candidate) : null
  const nestedAlts = nestedBrace === null ? undefined : parseBraceRangeAlternatives(nestedBrace[1]!)
  if (nestedBrace !== null && nestedAlts !== undefined) {
    const nPrefix = candidate.slice(0, nestedBrace.index)
    const nSuffix = candidate.slice(nestedBrace.index + nestedBrace[0].length)
    let subTrunc = nestedAlts.length > 16
    for (const nAlt of nestedAlts.slice(0, 16)) {
      if (
        emitExpandedTailVariants(`${nPrefix}${nAlt}${nSuffix}`, braceDepth + 1, out, pushUnique)
      ) {
        subTrunc = true
      }
    }
    return subTrunc
  }
  pushUnique(candidate)
  pushUnique(path.posix.normalize(candidate))
  const strippedResult = stripGlobCharClasses(candidate)
  for (const stripped of strippedResult.candidates) {
    pushUnique(stripped)
    pushUnique(path.posix.normalize(stripped))
  }
  return strippedResult.truncated || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(candidate)
}

const expandGlobObfuscationCandidates = (
  raw: string,
): { readonly candidates: ReadonlyArray<string>; readonly truncated: boolean } => {
  const out: Array<string> = []
  const seen = new Set<string>()
  let truncated = false
  const pushUnique = (val: string): void => {
    if (val.length > 0 && !seen.has(val)) {
      seen.add(val)
      out.push(val)
    }
  }
  const queue: Array<string> = [raw]
  for (let pass = 0; pass < 2; pass++) {
    const nextQueue: Array<string> = []
    for (const item of queue) {
      const brace = /\{([^{}]{1,4096})\}/.exec(item)
      const rawAlts = brace === null ? undefined : parseBraceRangeAlternatives(brace[1]!)
      if (brace === null || rawAlts === undefined) {
        nextQueue.push(item)
        continue
      }
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
      for (const tailAlt of rawAlts.slice(8, 512)) {
        if (emitExpandedTailVariants(`${prefix}${tailAlt}${suffix}`, pass + 1, out, pushUnique)) {
          truncated = true
        }
      }
    }
    queue.splice(0, queue.length, ...nextQueue)
  }
  for (const item of queue) {
    if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(item)) {
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

export const normalizeFilePathCandidates = (
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
  const seen = new Set<string>()
  let truncated = false
  for (const base of bases) {
    const expanded = expandGlobObfuscationCandidates(base)
    if (expanded.truncated) truncated = true
    for (const variant of expanded.candidates) {
      if (!seen.has(variant)) {
        seen.add(variant)
        out.push(variant)
      }
    }
  }
  return { candidates: out, truncated }
}
