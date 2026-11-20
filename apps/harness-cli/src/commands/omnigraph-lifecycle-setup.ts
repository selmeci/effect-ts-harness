import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  OmnigraphBaseUrl,
  OmnigraphIsoTimestamp,
  OmnigraphProcessId,
  type OmnigraphServerMeta,
  OmnigraphServerMetaSchema,
  OmnigraphTcpPort,
  WorkspaceFilePath,
} from "@harness/contract"
import { nodeSyncHostIo } from "@harness/infra"
import {
  ensureOmnigraphEndpointTokens,
  killOmnigraphServerPidIfAlive,
  unlinkServerMetaIfExists,
  writeClusterDriftReceipts,
  writeServerMetaAtomic,
} from "./omnigraph-auth-and-drift.js"
import {
  clusterYamlDeclaresPolicies,
  isProcessPidAlive,
  probeOmnigraphServerReady,
} from "./omnigraph-safety-helpers.js"
import {
  clearPendingWorkflowRestoreJournal,
  matchExecSyncStdout,
  runWorkflowRestoreAfterRebuild,
  unlockOmnigraphClusterIfNeeded,
  verifyWorkflowGraphEmptyBeforeNonRebuildRestore,
  type WorkflowBeforeRebuildResult,
} from "./omnigraph-workflow-backup.js"

const DEFAULT_EMBEDDING_API_KEY = "ollama-local"
const DEFAULT_EMBEDDINGS_MOCK = "1"

const decodeOmnigraphServerMeta = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema),
)

export type ClusterSetupRes =
  | { readonly ok: true; readonly pid: number; readonly appliedCluster: boolean }
  | { readonly ok: false }

export interface ServerMetaReadResult {
  readonly serverMeta: OmnigraphServerMeta | undefined
  readonly corruptOrUnreadable: boolean
}

export const readClusterPoliciesFlag = (
  clusterYamlPath: string,
): { readonly ok: true; readonly hasPolicies: boolean } | { readonly ok: false } => {
  if (!nodeSyncHostIo.existsSync(clusterYamlPath)) {
    return { ok: true, hasPolicies: false }
  }
  return match(Result.try(() => nodeSyncHostIo.readTextSync(clusterYamlPath)))
    .with({ _tag: "Success" }, ({ success }) => ({
      ok: true as const,
      hasPolicies: clusterYamlDeclaresPolicies(success),
    }))
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:omnigraph] Error: failed to read ${clusterYamlPath}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      )
      return { ok: false as const }
    })
    .exhaustive()
}

export const readOmnigraphServerMetaChecked = (clusterRootDir: string): ServerMetaReadResult => {
  const serverJsonPath = join(clusterRootDir, "server.json")
  if (nodeSyncHostIo.isSymbolicLinkSync(serverJsonPath)) {
    process.stderr.write(
      `[harness:omnigraph] Warning: refusing symlink server metadata file: ${serverJsonPath}\n`,
    )
    return { serverMeta: undefined, corruptOrUnreadable: true }
  }
  if (!nodeSyncHostIo.existsSync(serverJsonPath)) {
    return { serverMeta: undefined, corruptOrUnreadable: false }
  }
  return match(Result.try(() => nodeSyncHostIo.readTextSync(serverJsonPath)))
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[harness:omnigraph] Warning: failed to read ${serverJsonPath}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
      )
      return { serverMeta: undefined, corruptOrUnreadable: true }
    })
    .with({ _tag: "Success" }, ({ success }) =>
      match(decodeOmnigraphServerMeta(success))
        .with({ _tag: "Some" }, ({ value }) => ({
          serverMeta: value,
          corruptOrUnreadable: false,
        }))
        .with({ _tag: "None" }, () => {
          process.stderr.write(
            `[harness:omnigraph] Warning: failed to decode ${serverJsonPath} as OmnigraphServerMeta JSON\n`,
          )
          return { serverMeta: undefined, corruptOrUnreadable: true }
        })
        .exhaustive(),
    )
    .exhaustive()
}

export const restorePendingWorkflowOnLiveServer = (options: {
  readonly clusterRepoRoot: string
  readonly clusterRootDir: string
  readonly baseUrl: string
  readonly backup: WorkflowBeforeRebuildResult | undefined
  readonly verifyEmptyBeforeRestore: boolean
  readonly driftActionTag: "NoOp" | "LiveClusterApply"
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (options.backup === undefined) {
      return true
    }
    if (options.verifyEmptyBeforeRestore) {
      const isEmpty = yield* verifyWorkflowGraphEmptyBeforeNonRebuildRestore({
        clusterRepoRoot: options.clusterRepoRoot,
        clusterRootDir: options.clusterRootDir,
        baseUrl: options.baseUrl,
        driftActionTag: options.driftActionTag,
      })
      if (!isEmpty) {
        return false
      }
    }
    const ok = yield* runWorkflowRestoreAfterRebuild({
      clusterRepoRoot: options.clusterRepoRoot,
      clusterRootDir: options.clusterRootDir,
      baseUrl: options.baseUrl,
      backup: options.backup,
    })
    if (ok) {
      clearPendingWorkflowRestoreJournal(options.clusterRepoRoot)
    }
    return ok
  })

export const setupAndSpawnOmnigraphCluster = (options: {
  readonly clusterRepoRoot: string
  readonly clusterRootDir: string
  readonly configDir: string
  readonly omnigraphBin: string
  readonly omnigraphServerBin: string
  readonly targetBaseUrl: string
  readonly defaultPort: number
  readonly hasPolicies: boolean
  readonly applyCluster: boolean
}): Effect.Effect<ClusterSetupRes> =>
  Effect.try({
    try: (): ClusterSetupRes => {
      if (!nodeSyncHostIo.existsSync(options.clusterRootDir)) {
        nodeSyncHostIo.mkdirRecursiveSync(options.clusterRootDir)
      }
      const tokensOutcome = options.hasPolicies
        ? match(ensureOmnigraphEndpointTokens(options.clusterRootDir))
            .with({ _tag: "Success" }, ({ success }) => ({
              ok: true as const,
              tokens: success,
            }))
            .with({ _tag: "Failure" }, ({ failure }) => {
              process.stderr.write(`[harness:omnigraph] ${failure.message}\n`)
              return { ok: false as const, tokens: undefined }
            })
            .exhaustive()
        : { ok: true as const, tokens: undefined }
      if (!tokensOutcome.ok) {
        return { ok: false }
      }
      const tokens = tokensOutcome.tokens
      const preUnlock = unlockOmnigraphClusterIfNeeded(options.omnigraphBin, options.clusterRootDir)
      if (!preUnlock.ok) {
        return { ok: false }
      }
      let appliedCluster = false
      const graphOmniDir = join(options.clusterRootDir, "graphs", "harness.omni")
      if (options.applyCluster || !nodeSyncHostIo.existsSync(graphOmniDir)) {
        const outRes = nodeSyncHostIo.execFileSync(
          options.omnigraphBin,
          [
            "cluster",
            "apply",
            "--target",
            `file://${options.clusterRootDir}`,
            "--config",
            options.configDir,
            "--as",
            "harness-cli",
            "--json",
          ],
          { cwd: options.clusterRepoRoot, timeoutMs: 30_000 },
        )
        const applyStdout = matchExecSyncStdout("Local omnigraph cluster apply failed", outRes)
        if (applyStdout === undefined) return { ok: false }
        if (
          !unlockOmnigraphClusterIfNeeded(options.omnigraphBin, options.clusterRootDir, applyStdout)
            .ok
        ) {
          return { ok: false }
        }
        appliedCluster = true
      }
      if (!unlockOmnigraphClusterIfNeeded(options.omnigraphBin, options.clusterRootDir).ok) {
        return { ok: false }
      }
      const bindHostPort =
        options.targetBaseUrl.match(/^https?:\/\/([^/]+)/)?.[1] ??
        `127.0.0.1:${options.defaultPort}`
      if (!options.hasPolicies) {
        process.stderr.write(
          "[harness:omnigraph] Warning: spawning omnigraph-server with --unauthenticated because cluster.yaml declares no policies:\n",
        )
      }
      const spawnArgs = [
        "--cluster",
        `file://${options.clusterRootDir}`,
        "--bind",
        bindHostPort,
        ...(options.hasPolicies ? [] : ["--unauthenticated"]),
      ]
      const hasExplicitEmbeddingKey =
        typeof process.env.OMNIGRAPH_EMBEDDING_API_KEY === "string" &&
        process.env.OMNIGRAPH_EMBEDDING_API_KEY.length > 0
      if (process.env.OMNIGRAPH_EMBEDDINGS_MOCK === undefined && !hasExplicitEmbeddingKey) {
        process.stderr.write(
          "[harness:omnigraph] Warning: OMNIGRAPH_EMBEDDING_API_KEY not set; spawning omnigraph-server with deterministic mock embeddings (OMNIGRAPH_EMBEDDINGS_MOCK=1)\n",
        )
      }
      const spawnEnv: Record<string, string | undefined> = {
        ...process.env,
        OMNIGRAPH_EMBEDDING_API_KEY:
          process.env.OMNIGRAPH_EMBEDDING_API_KEY ?? DEFAULT_EMBEDDING_API_KEY,
      }
      const mockFlag =
        process.env.OMNIGRAPH_EMBEDDINGS_MOCK ??
        (hasExplicitEmbeddingKey ? undefined : DEFAULT_EMBEDDINGS_MOCK)
      if (mockFlag !== undefined) {
        spawnEnv.OMNIGRAPH_EMBEDDINGS_MOCK = mockFlag
      } else {
        delete spawnEnv.OMNIGRAPH_EMBEDDINGS_MOCK
      }
      if (tokens !== undefined) {
        spawnEnv.OMNIGRAPH_SERVER_BEARER_TOKENS_JSON = JSON.stringify({
          "harness-cli": tokens.cliToken,
          "agent-mcp": tokens.mcpToken,
        })
      }
      const spawnRes = nodeSyncHostIo.spawnDetached(options.omnigraphServerBin, spawnArgs, {
        cwd: options.clusterRepoRoot,
        stderrLogPath: join(options.clusterRootDir, "omnigraph-spawn.stderr.log"),
        env: spawnEnv,
      })
      return match(spawnRes)
        .with({ _tag: "SpawnFailed" }, ({ spawnError }): ClusterSetupRes => {
          process.stderr.write(
            `[harness:omnigraph] Failed to spawn omnigraph-server: ${spawnError}\n`,
          )
          return { ok: false }
        })
        .with({ _tag: "Spawned" }, ({ pid }): ClusterSetupRes => ({
          ok: true,
          pid,
          appliedCluster,
        }))
        .exhaustive()
    },
    catch: (err): ClusterSetupRes => {
      process.stderr.write(
        `[harness:omnigraph] Local omnigraph setup/spawn failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ok: false }
    },
  }).pipe(Effect.orElseSucceed((): ClusterSetupRes => ({ ok: false })))

export const waitForSpawnedOmnigraphReady = (options: {
  readonly clusterRepoRoot: string
  readonly clusterRootDir: string
  readonly canonicalRepoRoot: string
  readonly configDir: string
  readonly expectedStamp: string
  readonly targetBaseUrl: string
  readonly defaultPort: number
  readonly spawnedPid: number
  readonly appliedCluster: boolean
  readonly workflowBackup: WorkflowBeforeRebuildResult | undefined
  readonly verifyEmptyBeforeRestore: boolean
  readonly driftActionTag: "NoOp" | "LiveClusterApply"
  readonly onSuccessClearSpawnedPid: () => void
  readonly cleanupSpawned: (reason: string) => Effect.Effect<void>
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    let lastFailureReason = "unknown"
    for (let i = 0; i < 30; i++) {
      if (!isProcessPidAlive(options.spawnedPid)) {
        lastFailureReason = `spawned omnigraph-server PID ${options.spawnedPid} exited prematurely`
        break
      }
      const probe = yield* probeOmnigraphServerReady(options.targetBaseUrl)
      const isReady = match(probe)
        .with({ _tag: "Ready" }, () => true)
        .with({ _tag: "NotReady" }, ({ reason }) => {
          lastFailureReason = reason
          return false
        })
        .exhaustive()
      if (isReady) {
        const restoreOk = yield* restorePendingWorkflowOnLiveServer({
          clusterRepoRoot: options.clusterRepoRoot,
          clusterRootDir: options.clusterRootDir,
          baseUrl: options.targetBaseUrl,
          backup: options.workflowBackup,
          verifyEmptyBeforeRestore: options.verifyEmptyBeforeRestore,
          driftActionTag: options.driftActionTag,
        })
        if (!restoreOk) {
          yield* options.cleanupSpawned("workflow backup restore failure")
          return false
        }
        const parsedPort = Result.getOrElse(
          Result.try(() => Number(new URL(options.targetBaseUrl).port) || options.defaultPort),
          () => options.defaultPort,
        )
        const metaWriteErr = match(
          writeServerMetaAtomic(options.clusterRootDir, {
            pid: OmnigraphProcessId.make(options.spawnedPid),
            port: OmnigraphTcpPort.make(parsedPort),
            baseUrl: OmnigraphBaseUrl.make(options.targetBaseUrl),
            canonicalRepoRoot: WorkspaceFilePath.make(options.canonicalRepoRoot),
            updatedAt: OmnigraphIsoTimestamp.make(new Date().toISOString()),
          }),
        )
          .with({ _tag: "Success" }, () => undefined)
          .with({ _tag: "Failure" }, ({ failure }) => failure.message)
          .exhaustive()
        if (metaWriteErr !== undefined) {
          process.stderr.write(
            `[harness:omnigraph] Error: failed to write server.json: ${metaWriteErr}\n`,
          )
          yield* options.cleanupSpawned("server.json write failure")
          return false
        }
        if (options.appliedCluster) {
          writeClusterDriftReceipts(
            options.clusterRootDir,
            options.expectedStamp,
            options.configDir,
          )
        }
        options.onSuccessClearSpawnedPid()
        return true
      }
      yield* Effect.sleep("100 millis")
    }
    yield* options.cleanupSpawned("readyz timeout")
    process.stderr.write(
      `[harness:omnigraph] Omnigraph server did not become ready at ${options.targetBaseUrl}/readyz: ${lastFailureReason}\n`,
    )
    return false
  })

export const cleanupSpawnedOmnigraphServer = (
  pid: number | undefined,
  clusterRootDir: string,
  reason: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (pid !== undefined) {
      yield* killOmnigraphServerPidIfAlive(pid, clusterRootDir, reason)
    }
    unlinkServerMetaIfExists(clusterRootDir)
  })
