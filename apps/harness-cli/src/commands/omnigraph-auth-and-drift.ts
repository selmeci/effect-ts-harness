import { createHash, randomBytes } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { Effect, Result, Schema } from "effect"
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
} from "@harness/infra"
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
    "queries/harness.gq": Schema.String,
    "graph.policy.yaml": Schema.String,
    "cluster.policy.yaml": Schema.String,
    "workflows.schema.pg": Schema.optional(Schema.String),
    "workflows.schema.pg@keys": Schema.optional(Schema.String),
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

export const computeOmnigraphConfigStamp = (configDir: string): string => {
  const baseFiles = ["cluster.yaml", "schema.pg", "queries/harness.gq"]
  const optionalConfigFiles = [
    "graph.policy.yaml",
    "cluster.policy.yaml",
    "workflows.schema.pg",
    "workflow-queries/workflows.gq",
    "workflows.policy.yaml",
  ].filter((f) => nodeSyncHostIo.existsSync(join(configDir, f)))
  return [...baseFiles, ...optionalConfigFiles]
    .map((f) => {
      const p = join(configDir, f)
      return nodeSyncHostIo.existsSync(p) ? nodeSyncHostIo.readTextSync(p) : ""
    })
    .join("\n---\n")
}

export const extractSchemaEdgeKeyDigest = (schemaContent: string): string => {
  const keys = Array.from(schemaContent.matchAll(/@key\s*\([^)]*\)/g))
    .map((m) => m[0].replace(/\s+/g, " ").trim())
    .sort()
  return createHash("sha256").update(keys.join("\n")).digest("hex")
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
    "queries/harness.gq": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[2])),
    "graph.policy.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[3])),
    "cluster.policy.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[4])),
    "workflows.schema.pg": hashContent(workflowsSchemaContent),
    "workflows.schema.pg@keys": extractSchemaEdgeKeyDigest(workflowsSchemaContent),
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

    const prevDigestsOpt = nodeSyncHostIo.existsSync(digestsPath)
      ? Schema.decodeOption(ConfigDigestsSchema)(nodeSyncHostIo.readTextSync(digestsPath))
      : undefined
    const prevDigests =
      prevDigestsOpt !== undefined
        ? match(prevDigestsOpt)
            .with({ _tag: "Some" }, ({ value }) => value)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()
        : undefined

    const currentStamp = nodeSyncHostIo.existsSync(stampPath)
      ? nodeSyncHostIo.readTextSync(stampPath)
      : ""
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
          (prevDigests["schema.pg@keys"] !== undefined &&
            digests["schema.pg@keys"] !== prevDigests["schema.pg@keys"]) ||
          (prevDigests["workflows.schema.pg@keys"] !== undefined &&
            digests["workflows.schema.pg@keys"] !== prevDigests["workflows.schema.pg@keys"])
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
