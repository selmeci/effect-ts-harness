import { createHash, randomBytes } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { Effect, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  OmnigraphActorToken,
  type OmnigraphAuthTokens,
  OmnigraphAuthTokensSchema,
  type OmnigraphConfigDriftKind,
  type OmnigraphSchemaEvolutionAction,
  type OmnigraphServerMeta,
} from "@harness/contract"
import { decideOmnigraphSchemaEvolution } from "@harness/gates"
import {
  acquireOmnigraphClusterLockEffect,
  nodeSyncHostIo,
  type OmnigraphClusterLockAttemptResult,
  type OmnigraphClusterLockHandle,
  type OmnigraphClusterStartupLockOptions,
  releaseOmnigraphClusterLock,
  tryAcquireOmnigraphClusterLock,
  withOmnigraphClusterStartupLock,
} from "@harness/infra/omnigraph-session"
import {
  isProcessPidAlive,
  isSafeOmnigraphPidToKill,
  resolveDefaultOmnigraphBin,
  runOmnigraphOptimizeAndCleanup,
} from "./omnigraph-safety-helpers.js"
import {
  type OfflineOmnigraphLintResult,
  runOfflineOmnigraphLintGate,
} from "./omnigraph-lint-gate.js"
import { matchExecSyncStdout } from "./omnigraph-workflow-backup.js"
import { buildOmnigraphClusterKillArgs } from "./repo-path.js"

export {
  acquireOmnigraphClusterLockEffect,
  type OfflineOmnigraphLintResult,
  type OmnigraphClusterLockAttemptResult,
  type OmnigraphClusterLockHandle,
  type OmnigraphClusterStartupLockOptions,
  releaseOmnigraphClusterLock,
  resolveDefaultOmnigraphBin,
  runOfflineOmnigraphLintGate,
  runOmnigraphOptimizeAndCleanup,
  tryAcquireOmnigraphClusterLock,
  withOmnigraphClusterStartupLock,
}

export const CLUSTER_SCHEMA_EPOCH = "three-tier-retrieval-v3"

const CONFIG_DIGEST_FILES = [
  "cluster.yaml",
  "schema.pg",
  "queries/harness.gq",
  "graph.policy.yaml",
  "cluster.policy.yaml",
  "workflows.schema.pg",
  "workflow-queries/workflows.gq",
  "workflows.policy.yaml",
] as const

const ConfigDigestsSchema = Schema.fromJsonString(
  Schema.Struct({
    "cluster.yaml": Schema.String,
    "schema.pg": Schema.String,
    "schema.pg@keys": Schema.optional(Schema.String),
    "schema.pg@edgeKeys": Schema.optional(Schema.Record(Schema.String, Schema.String)),
    "queries/harness.gq": Schema.String,
    "graph.policy.yaml": Schema.String,
    "cluster.policy.yaml": Schema.String,
    "workflows.schema.pg": Schema.optional(Schema.String),
    "workflows.schema.pg@keys": Schema.optional(Schema.String),
    "workflows.schema.pg@edgeKeys": Schema.optional(Schema.Record(Schema.String, Schema.String)),
    "workflow-queries/workflows.gq": Schema.optional(Schema.String),
    "workflows.policy.yaml": Schema.optional(Schema.String),
  }),
)

type ConfigDigests = Schema.Schema.Type<typeof ConfigDigestsSchema>

const EndpointTokensJsonSchema = Schema.fromJsonString(OmnigraphAuthTokensSchema)

export type OmnigraphEndpointTokens = OmnigraphAuthTokens

export const resolveOmnigraphConfigDir = (
  repoRoot: string,
  canonicalRepoRoot: string,
  allowWorktreeOverride = process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD === "1",
  isIsolatedStateCluster = false,
): string => {
  const canonicalConfigDir = join(canonicalRepoRoot, "libs", "harness", "graph")
  if (
    !allowWorktreeOverride &&
    !isIsolatedStateCluster &&
    resolve(repoRoot) !== resolve(canonicalRepoRoot) &&
    nodeSyncHostIo.existsSync(join(canonicalConfigDir, "cluster.yaml"))
  ) {
    return canonicalConfigDir
  }
  const worktreeConfigDir = join(repoRoot, "libs", "harness", "graph")
  return nodeSyncHostIo.existsSync(join(worktreeConfigDir, "cluster.yaml"))
    ? worktreeConfigDir
    : canonicalConfigDir
}

export const computeOmnigraphConfigStamp = (configDir: string): string =>
  [
    ...CONFIG_DIGEST_FILES.slice(0, 3),
    ...CONFIG_DIGEST_FILES.slice(3).filter((f) => nodeSyncHostIo.existsSync(join(configDir, f))),
  ]
    .map((f) => {
      const p = join(configDir, f)
      return nodeSyncHostIo.existsSync(p) ? nodeSyncHostIo.readTextSync(p) : ""
    })
    .join("\n---\n")

export const UNPARSEABLE_SCHEMA_EDGE_KEYS_MARKER = "__unparseable_edge_keys__"

export type SchemaEdgeKeysParseResult =
  | { readonly _tag: "Parsed"; readonly edgeKeys: Readonly<Record<string, string>> }
  | { readonly _tag: "Unparseable"; readonly reason: string }

const stripPgCommentsAndMaskStrings = (content: string): string =>
  content.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (tok) =>
    tok.startsWith('"') ? `"${" ".repeat(Math.max(0, tok.length - 2))}"` : "",
  )

const scanBalancedEnd = (s: string, openPos: number, openCh: string, closeCh: string): number => {
  let depth = 1
  let pos = openPos + 1
  while (pos < s.length && depth > 0) {
    depth += match(s[pos])
      .with(openCh, () => 1)
      .with(closeCh, () => -1)
      .otherwise(() => 0)
    pos += 1
  }
  return depth === 0 ? pos : -1
}

const parseEdgeKeyFromDecl = (edgeName: string, declSlice: string): string | undefined | Error => {
  const keyMatches = Array.from(declSlice.matchAll(/@key\b/g))
  if (keyMatches.length > 1) return new Error(`Multiple @key declarations in edge ${edgeName}`)
  const idx = keyMatches[0]?.index
  if (idx === undefined) return undefined
  const offset = declSlice.slice(idx + 4).search(/\S/)
  const openPos = offset >= 0 ? idx + 4 + offset : -1
  if (openPos < 0 || declSlice[openPos] !== "(") {
    return new Error(`Malformed @key without '(' in edge ${edgeName}`)
  }
  const closeParen = scanBalancedEnd(declSlice, openPos, "(", ")")
  if (closeParen < 0) return new Error(`Unclosed @key(...) in edge ${edgeName}`)
  const normalized = declSlice.slice(idx, closeParen).replace(/\s+/g, " ").trim()
  return normalized.slice(normalized.indexOf("(") + 1, -1).trim().length === 0
    ? new Error(`Empty @key() in edge ${edgeName}`)
    : normalized
}

const findDeclEnd = (clean: string, start: number, label: string): number | Error => {
  let parenDepth = 0
  for (let i = start; i < clean.length; i += 1) {
    const ch = clean[i]
    parenDepth += match(ch)
      .with("(", () => 1)
      .with(")", () => -1)
      .otherwise(() => 0)
    if (parenDepth < 0) return new Error(`Unbalanced ')' in ${label}`)
    if (parenDepth === 0 && ch === "{") {
      const end = scanBalancedEnd(clean, i, "{", "}")
      return end < 0 ? new Error(`Unclosed brace in ${label}`) : end
    }
    if (
      parenDepth === 0 &&
      !/[A-Za-z0-9_]/.test(clean[i - 1] ?? "") &&
      /^(?:node|edge)\b/.test(clean.slice(i))
    ) {
      return i
    }
  }
  return parenDepth === 0 ? clean.length : new Error(`Unclosed parenthesis in ${label}`)
}

export const parseSchemaEdgeKeys = (schemaContent: string): SchemaEdgeKeysParseResult => {
  const clean = stripPgCommentsAndMaskStrings(schemaContent)
  const edgeKeys: Record<string, string> = {}
  const declStartRe = /\b(?:node|edge)\b/g
  let pos = 0
  while (pos < clean.length) {
    declStartRe.lastIndex = pos
    const matchDecl = declStartRe.exec(clean)
    if (matchDecl === null) break
    const kw = matchDecl[0]
    const nameMatch = /^\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(clean.slice(matchDecl.index + kw.length))
    if (nameMatch?.[1] === undefined) {
      return { _tag: "Unparseable", reason: `Malformed ${kw} declaration missing identifier` }
    }
    const declName = nameMatch[1]
    const declEnd = findDeclEnd(
      clean,
      matchDecl.index + kw.length + nameMatch[0].length,
      `${kw} ${declName}`,
    )
    if (declEnd instanceof Error) return { _tag: "Unparseable", reason: declEnd.message }
    if (kw === "edge") {
      const keyOrErr = parseEdgeKeyFromDecl(declName, clean.slice(matchDecl.index, declEnd))
      if (keyOrErr instanceof Error) return { _tag: "Unparseable", reason: keyOrErr.message }
      if (keyOrErr !== undefined) edgeKeys[declName] = keyOrErr
    }
    pos = declEnd
  }
  return { _tag: "Parsed", edgeKeys }
}

export const extractSchemaEdgeKeyDigest = (schemaContent: string): string => {
  const keys = Array.from(
    stripPgCommentsAndMaskStrings(schemaContent).matchAll(/@key\s*\([^)]*\)/g),
  )
    .map((m) => m[0].replace(/\s+/g, " ").trim())
    .sort()
  return createHash("sha256").update(keys.join("\n")).digest("hex")
}

export const extractSchemaEdgeKeys = (schemaContent: string): Readonly<Record<string, string>> =>
  match(parseSchemaEdgeKeys(schemaContent))
    .with({ _tag: "Parsed" }, ({ edgeKeys }) => edgeKeys)
    .with({ _tag: "Unparseable" }, ({ reason }) => ({
      [UNPARSEABLE_SCHEMA_EDGE_KEYS_MARKER]: reason,
    }))
    .exhaustive()

const hasOwn = (obj: Readonly<Record<string, string>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

export const hasBreakingSchemaEdgeKeyChange = (
  prevEdgeKeys: Readonly<Record<string, string>>,
  currEdgeKeys: Readonly<Record<string, string>>,
): boolean => {
  if (
    hasOwn(prevEdgeKeys, UNPARSEABLE_SCHEMA_EDGE_KEYS_MARKER) ||
    hasOwn(currEdgeKeys, UNPARSEABLE_SCHEMA_EDGE_KEYS_MARKER)
  ) {
    return true
  }
  return Object.entries(prevEdgeKeys).some(
    ([edgeName, prevKey]) => !hasOwn(currEdgeKeys, edgeName) || currEdgeKeys[edgeName] !== prevKey,
  )
}

const isSchemaEdgeKeyBreaking = (
  key: "schema.pg" | "workflows.schema.pg",
  prevDigests: ConfigDigests,
  currDigests: ConfigDigests,
  prevLegacySchemaContent: string | undefined,
  requirePriorStamp: boolean,
): boolean => {
  const currEdgeKeys = currDigests[`${key}@edgeKeys`] ?? {}
  if (hasOwn(currEdgeKeys, UNPARSEABLE_SCHEMA_EDGE_KEYS_MARKER)) return true
  const prevEdgeKeys = prevDigests[`${key}@edgeKeys`]
  if (prevEdgeKeys !== undefined) return hasBreakingSchemaEdgeKeyChange(prevEdgeKeys, currEdgeKeys)
  if (prevLegacySchemaContent !== undefined && prevLegacySchemaContent.trim().length > 0) {
    return hasBreakingSchemaEdgeKeyChange(
      extractSchemaEdgeKeys(prevLegacySchemaContent),
      currEdgeKeys,
    )
  }
  const hasContent = (digest: string | undefined): boolean =>
    digest !== undefined && digest !== EMPTY_CONTENT_SHA256
  if (requirePriorStamp || hasContent(prevDigests[key]) || hasContent(prevDigests[`${key}@keys`])) {
    return true
  }
  return hasContent(currDigests[key]) && Object.keys(currEdgeKeys).length > 0
}

const extractPrevWorkflowsSchemaContent = (
  prevStampSegments: ReadonlyArray<string>,
  configDir: string,
): string | undefined => {
  if (prevStampSegments.length < 3) return undefined
  const optionalConfigFiles = CONFIG_DIGEST_FILES.slice(3).filter((f) =>
    nodeSyncHostIo.existsSync(join(configDir, f)),
  )
  const wfSchemaIdx = optionalConfigFiles.indexOf("workflows.schema.pg")
  const optionalSegments = prevStampSegments.slice(3)
  if (wfSchemaIdx >= 0 && prevStampSegments.length === 3 + optionalConfigFiles.length) {
    return optionalSegments[wfSchemaIdx]
  }
  return optionalSegments.find(
    (seg) =>
      !/^\s*(?:version:|query\s+)/m.test(seg) &&
      /^[ \t]*(?:node|edge)[ \t]+(?:Wf[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)/m.test(seg),
  )
}

const EMPTY_CONTENT_SHA256 = createHash("sha256").update("").digest("hex")

export const computeConfigDigests = (configDir: string): ConfigDigests => {
  const readFileOrEmpty = (relPath: string): string => {
    const fullPath = join(configDir, relPath)
    return nodeSyncHostIo.existsSync(fullPath) ? nodeSyncHostIo.readTextSync(fullPath) : ""
  }
  const hashContent = (content: string): string =>
    createHash("sha256").update(content).digest("hex")
  const schemaContent = readFileOrEmpty(CONFIG_DIGEST_FILES[1])
  const workflowsSchemaContent = readFileOrEmpty(CONFIG_DIGEST_FILES[5])
  return {
    "cluster.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[0])),
    "schema.pg": hashContent(schemaContent),
    "schema.pg@keys": extractSchemaEdgeKeyDigest(schemaContent),
    "schema.pg@edgeKeys": extractSchemaEdgeKeys(schemaContent),
    "queries/harness.gq": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[2])),
    "graph.policy.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[3])),
    "cluster.policy.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[4])),
    "workflows.schema.pg": hashContent(workflowsSchemaContent),
    "workflows.schema.pg@keys": extractSchemaEdgeKeyDigest(workflowsSchemaContent),
    "workflows.schema.pg@edgeKeys": extractSchemaEdgeKeys(workflowsSchemaContent),
    "workflow-queries/workflows.gq": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[6])),
    "workflows.policy.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[7])),
  }
}

export interface ClusterConfigDriftEvaluation {
  readonly action: OmnigraphSchemaEvolutionAction
  readonly expectedStamp: string
  readonly digests: ConfigDigests
  readonly epochMismatch: boolean
}

export const evaluateClusterConfigDrift = (
  clusterRootDir: string,
  configDir: string,
  serverAlive = false,
): Effect.Effect<ClusterConfigDriftEvaluation> =>
  Effect.gen(function* () {
    const expectedStamp = computeOmnigraphConfigStamp(configDir)
    const digests = computeConfigDigests(configDir)
    const stampPath = join(clusterRootDir, ".config-stamp")
    const digestsPath = join(clusterRootDir, ".config-digests.json")
    const epochPath = join(clusterRootDir, ".cluster-schema-epoch")
    const graphOmniDir = join(clusterRootDir, "graphs", "harness.omni")

    const clusterExists =
      nodeSyncHostIo.existsSync(clusterRootDir) &&
      (nodeSyncHostIo.existsSync(graphOmniDir) || nodeSyncHostIo.existsSync(stampPath))

    const currentEpoch = nodeSyncHostIo.existsSync(epochPath)
      ? nodeSyncHostIo.readTextSync(epochPath).trim()
      : ""
    const epochMatches = currentEpoch === CLUSTER_SCHEMA_EPOCH

    const prevDigests = nodeSyncHostIo.existsSync(digestsPath)
      ? Option.getOrUndefined(
          Schema.decodeOption(ConfigDigestsSchema)(nodeSyncHostIo.readTextSync(digestsPath)),
        )
      : undefined

    const currentStamp = nodeSyncHostIo.existsSync(stampPath)
      ? nodeSyncHostIo.readTextSync(stampPath)
      : ""
    const prevStampSegments = currentStamp.length > 0 ? currentStamp.split("\n---\n") : []
    const prevMainSchemaContent = prevStampSegments.length >= 3 ? prevStampSegments[1] : undefined
    const prevWorkflowsSchemaContent = extractPrevWorkflowsSchemaContent(
      prevStampSegments,
      configDir,
    )
    const stampChanged = currentStamp !== expectedStamp

    const queriesChanged =
      prevDigests !== undefined
        ? digests["queries/harness.gq"] !== prevDigests["queries/harness.gq"] ||
          digests["workflow-queries/workflows.gq"] !==
            (prevDigests["workflow-queries/workflows.gq"] ?? EMPTY_CONTENT_SHA256)
        : stampChanged
    const schemaAdditiveChanged =
      prevDigests !== undefined
        ? digests["schema.pg"] !== prevDigests["schema.pg"] ||
          digests["workflows.schema.pg"] !==
            (prevDigests["workflows.schema.pg"] ?? EMPTY_CONTENT_SHA256)
        : stampChanged
    const policyBundleOrEdgeKeyChanged =
      (clusterExists && !epochMatches) ||
      (prevDigests !== undefined
        ? digests["cluster.yaml"] !== prevDigests["cluster.yaml"] ||
          digests["graph.policy.yaml"] !== prevDigests["graph.policy.yaml"] ||
          digests["cluster.policy.yaml"] !== prevDigests["cluster.policy.yaml"] ||
          digests["workflows.policy.yaml"] !==
            (prevDigests["workflows.policy.yaml"] ?? EMPTY_CONTENT_SHA256) ||
          isSchemaEdgeKeyBreaking("schema.pg", prevDigests, digests, prevMainSchemaContent, true) ||
          isSchemaEdgeKeyBreaking(
            "workflows.schema.pg",
            prevDigests,
            digests,
            prevWorkflowsSchemaContent,
            false,
          )
        : stampChanged)

    const driftKind: OmnigraphConfigDriftKind = policyBundleOrEdgeKeyChanged
      ? "edge-key-or-policy-bundle-breaking"
      : schemaAdditiveChanged
        ? "schema-additive-or-rename"
        : queriesChanged
          ? "queries-only"
          : "none"

    const action = yield* decideOmnigraphSchemaEvolution(
      clusterExists
        ? {
            _tag: "ClusterPresent",
            driftKind,
            serverAlive,
          }
        : {
            _tag: "ClusterMissing",
          },
    )

    return {
      action,
      expectedStamp,
      digests,
      epochMismatch: clusterExists && !epochMatches,
    }
  })

export const writeClusterDriftReceipts = (
  clusterRootDir: string,
  expectedStamp: string,
  configDir: string,
): void => {
  if (!nodeSyncHostIo.existsSync(clusterRootDir)) {
    nodeSyncHostIo.mkdirRecursiveSync(clusterRootDir)
  }
  const digests = computeConfigDigests(configDir)
  nodeSyncHostIo.writeTextSync(join(clusterRootDir, ".config-stamp"), expectedStamp)
  nodeSyncHostIo.writeTextSync(
    join(clusterRootDir, ".config-digests.json"),
    JSON.stringify(digests, null, 2),
  )
  nodeSyncHostIo.writeTextSync(join(clusterRootDir, ".cluster-schema-epoch"), CLUSTER_SCHEMA_EPOCH)
}

const ensureSecureClusterDir = (clusterRootDir: string): Result.Result<void, Error> => {
  if (nodeSyncHostIo.isSymbolicLinkSync(clusterRootDir)) {
    return Result.fail(new Error(`Refusing symlink cluster directory: ${clusterRootDir}`))
  }
  return Result.try({
    try: () => {
      if (!nodeSyncHostIo.existsSync(clusterRootDir)) {
        nodeSyncHostIo.mkdirRecursiveSync(clusterRootDir)
      }
      nodeSyncHostIo.chmodSync(clusterRootDir, 0o700)
    },
    catch: (failure) => (failure instanceof Error ? failure : new Error(String(failure))),
  })
}

const writeSecureJsonAtomic = (
  targetPath: string,
  payload: unknown,
): Result.Result<void, Error> => {
  const dir = dirname(targetPath)
  if (nodeSyncHostIo.isSymbolicLinkSync(dir) || nodeSyncHostIo.isSymbolicLinkSync(targetPath)) {
    return Result.fail(new Error(`Refusing symlink target path: ${targetPath}`))
  }
  return Result.flatMap(ensureSecureClusterDir(dir), () => {
    const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
    return Result.try({
      try: () => {
        nodeSyncHostIo.writeTextWithModeSync(tmpPath, JSON.stringify(payload, null, 2), 0o600)
        nodeSyncHostIo.chmodSync(tmpPath, 0o600)
        nodeSyncHostIo.renameSync(tmpPath, targetPath)
      },
      catch: (failure) => {
        Result.try(() => nodeSyncHostIo.unlinkSync(tmpPath))
        return failure instanceof Error ? failure : new Error(String(failure))
      },
    })
  })
}

export const writeServerMetaAtomic = (
  clusterRootDir: string,
  meta: OmnigraphServerMeta,
): Result.Result<void, Error> => writeSecureJsonAtomic(join(clusterRootDir, "server.json"), meta)

export const unlinkServerMetaIfExists = (clusterRootDir: string): void => {
  const serverJsonPath = join(clusterRootDir, "server.json")
  if (
    !nodeSyncHostIo.isSymbolicLinkSync(serverJsonPath) &&
    nodeSyncHostIo.existsSync(serverJsonPath)
  ) {
    Result.try(() => {
      nodeSyncHostIo.unlinkSync(serverJsonPath)
    })
  }
}

export const ensureOmnigraphEndpointTokens = (
  clusterRootDir: string,
): Result.Result<OmnigraphEndpointTokens, Error> => {
  const tokensPath = join(clusterRootDir, "auth-tokens.json")
  if (
    nodeSyncHostIo.isSymbolicLinkSync(clusterRootDir) ||
    nodeSyncHostIo.isSymbolicLinkSync(tokensPath)
  ) {
    return Result.fail(new Error(`Refusing symlink cluster auth path under ${clusterRootDir}`))
  }
  return match(ensureSecureClusterDir(clusterRootDir))
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, () => {
      if (nodeSyncHostIo.existsSync(tokensPath)) {
        const mode = nodeSyncHostIo.statModeSync(tokensPath)
        if (mode === undefined || (mode & 0o077) !== 0) {
          return Result.fail(
            new Error(
              mode === undefined
                ? `Unable to stat mode for auth-tokens.json: ${tokensPath}`
                : `Refusing to use auth-tokens.json with permissive mode ${mode.toString(8)}: ${tokensPath}`,
            ),
          )
        }
        const rawRes = Result.try({
          try: () => nodeSyncHostIo.readTextSync(tokensPath),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        })
        return match(rawRes)
          .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
          .with({ _tag: "Success" }, ({ success }) =>
            match(Schema.decodeOption(EndpointTokensJsonSchema)(success))
              .with({ _tag: "Some" }, ({ value }) => Result.succeed(value))
              .with({ _tag: "None" }, () =>
                Result.fail(
                  new Error(`Corrupt auth-tokens.json at ${tokensPath}; refusing to overwrite`),
                ),
              )
              .exhaustive(),
          )
          .exhaustive()
      }

      const tokens: OmnigraphEndpointTokens = {
        schemaVersion: 1,
        cliToken: OmnigraphActorToken.make(randomBytes(32).toString("hex")),
        mcpToken: OmnigraphActorToken.make(randomBytes(32).toString("hex")),
      }
      return Result.map(writeSecureJsonAtomic(tokensPath, tokens), () => tokens)
    })
    .exhaustive()
}

const sendSignalOrEsrch = (pid: number, signal: "SIGTERM" | "SIGKILL"): Effect.Effect<boolean> =>
  Effect.try({
    try: () => {
      process.kill(pid, signal)
      return true
    },
    catch: (err) => {
      const code =
        typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
          ? err.code
          : undefined
      if (code === "ESRCH") {
        return true
      }
      process.stderr.write(
        `[harness:omnigraph] Error: failed to ${signal} omnigraph PID ${pid}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return false
    },
  }).pipe(Effect.orElseSucceed(() => false))

export const killOmnigraphServerPidIfAlive = (
  serverPid: number | undefined,
  clusterRootDir: string,
  phaseLabel: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (
      typeof serverPid !== "number" ||
      !Number.isInteger(serverPid) ||
      serverPid <= 1 ||
      !isProcessPidAlive(serverPid)
    ) {
      return true
    }
    if (!isSafeOmnigraphPidToKill(serverPid, clusterRootDir)) {
      process.stderr.write(
        `[harness:omnigraph] Refusing to kill unsafe or non-omnigraph PID ${String(serverPid)} during ${phaseLabel}\n`,
      )
      return false
    }
    if (!(yield* sendSignalOrEsrch(serverPid, "SIGTERM"))) {
      return false
    }
    for (let attempt = 0; attempt < 10 && isProcessPidAlive(serverPid); attempt++) {
      yield* Effect.sleep("50 millis")
    }
    if (isProcessPidAlive(serverPid)) {
      if (!(yield* sendSignalOrEsrch(serverPid, "SIGKILL"))) {
        return false
      }
      for (let attempt = 0; attempt < 5 && isProcessPidAlive(serverPid); attempt++) {
        yield* Effect.sleep("50 millis")
      }
      if (isProcessPidAlive(serverPid)) {
        process.stderr.write(
          `[harness:omnigraph] Error: omnigraph PID ${serverPid} is still alive after SIGTERM+SIGKILL during ${phaseLabel}\n`,
        )
        return false
      }
    }
    return true
  })

export const stopStaleOmnigraphClusterBeforeDelete = (
  clusterRootDir: string,
  serverPid: number | undefined,
  hostIo: typeof nodeSyncHostIo = nodeSyncHostIo,
  isPidAlive: (pid: number) => boolean = isProcessPidAlive,
): boolean => {
  const [killBin, killArgs] = buildOmnigraphClusterKillArgs(clusterRootDir)
  const killResult = Result.try({
    try: () =>
      matchExecSyncStdout(
        "Warning: pkill",
        hostIo.execFileSync(killBin, [...killArgs], { timeoutMs: 5_000 }),
        true,
      ) !== undefined,
    catch: (err) => {
      process.stderr.write(
        `[harness:omnigraph] Warning: pkill failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return false
    },
  })
  const killOk = Result.getOrElse(killResult, () => false)
  if (!killOk) {
    if (serverPid !== undefined && isPidAlive(serverPid)) {
      process.stderr.write(
        `[harness:omnigraph] Error: pkill failed and stale omnigraph PID ${serverPid} is still alive; aborting RocksDB cleanup\n`,
      )
    }
    return false
  }
  return true
}
