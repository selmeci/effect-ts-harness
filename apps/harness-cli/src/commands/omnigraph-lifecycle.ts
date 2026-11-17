import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"

type SyncHostIo = typeof nodeSyncHostIo
import {
  clusterYamlDeclaresPolicies,
  isLoopbackOmnigraphUrl,
  isProcessPidAlive,
  isSafeOmnigraphPidToKill,
  isValidLockId,
  probeOmnigraphServerReady,
} from "./omnigraph-safety-helpers.js"
import {
  acquireOmnigraphClusterLockEffect,
  ensureOmnigraphEndpointTokens,
  evaluateClusterConfigDrift,
  killOmnigraphServerPidIfAlive,
  releaseOmnigraphClusterLock,
  resolveOmnigraphConfigDir,
  writeClusterDriftReceipts,
  writeServerMetaAtomic,
} from "./omnigraph-auth-and-drift.js"

const DEFAULT_EMBEDDING_API_KEY = "ollama-local"
const DEFAULT_EMBEDDINGS_MOCK = "1"

export { isLoopbackOmnigraphUrl, isProcessPidAlive, isSafeOmnigraphPidToKill, isValidLockId }

const walkUpForPnpmWorkspace = (startDir: string): string | undefined => {
  let curr = resolve(startDir)
  while (curr !== dirname(curr)) {
    if (nodeSyncHostIo.existsSync(join(curr, "pnpm-workspace.yaml"))) return curr
    curr = dirname(curr)
  }
  return undefined
}

export const CLI_REPO_ROOT =
  walkUpForPnpmWorkspace(dirname(fileURLToPath(import.meta.url))) ?? process.cwd()

export const findWorkspaceRoot = (startDir: string = process.cwd()): string =>
  walkUpForPnpmWorkspace(startDir) ?? CLI_REPO_ROOT

export const resolveClusterRepoRoot = (repoRoot: string): string =>
  nodeSyncHostIo.existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
    ? repoRoot
    : (walkUpForPnpmWorkspace(repoRoot) ?? resolve(repoRoot))

const LockJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

export interface UnlockClusterResult {
  readonly ok: boolean
  readonly reason?: string | undefined
}

export function unlockOmnigraphClusterIfNeeded(
  omnigraphBin: string,
  clusterRootDir: string,
  applyOutput?: string,
): UnlockClusterResult {
  const lockIds = new Set<string>()
  if (applyOutput) {
    const lockMatch = applyOutput.match(/Admission lock:\s*([A-Za-z0-9._-]+)/)
    if (lockMatch?.[1] && isValidLockId(lockMatch[1])) {
      lockIds.add(lockMatch[1])
    }
  }
  const lockPath = join(clusterRootDir, "__cluster", "lock.json")
  if (nodeSyncHostIo.existsSync(lockPath)) {
    const readRes = Result.try(() => nodeSyncHostIo.readTextSync(lockPath))
    const rawLock = match(readRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) => {
        const reason = `Failed to read ${lockPath}: ${failure instanceof Error ? failure.message : String(failure)}`
        process.stderr.write(`[harness:omnigraph] ${reason}\n`)
        return undefined
      })
      .exhaustive()
    if (rawLock === undefined) {
      return { ok: false, reason: `failed-to-read-lock-json` }
    }
    const parsedOpt = Schema.decodeOption(LockJsonSchema)(rawLock)
    const decodedOk = match(parsedOpt)
      .with({ _tag: "Some" }, ({ value }) => {
        for (const key of ["lock_id", "id", "lockId"]) {
          const val = value[key]
          if (typeof val === "string" && val.length > 0) {
            if (isValidLockId(val)) {
              lockIds.add(val)
            } else {
              process.stderr.write(
                `[harness:omnigraph] Ignoring invalid lock.json ${key}: ${val}\n`,
              )
            }
          }
        }
        return true
      })
      .with({ _tag: "None" }, () => {
        process.stderr.write(
          `[harness:omnigraph] Error: failed to decode ${lockPath} as JSON\n`,
        )
        return false
      })
      .exhaustive()
    if (!decodedOk) {
      return { ok: false, reason: `invalid-lock-json` }
    }
  }
  for (const lockId of lockIds) {
    const execTry = Result.try(() =>
      nodeSyncHostIo.execFileSync(
        omnigraphBin,
        ["cluster", "force-unlock", lockId, "--target", `file://${clusterRootDir}`],
        { timeoutMs: 5_000 },
      ),
    )
    const unlockOk = match(execTry)
      .with({ _tag: "Failure" }, ({ failure }) => {
        process.stderr.write(
          `[harness:omnigraph] force-unlock threw for ${lockId}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
        )
        return false
      })
      .with({ _tag: "Success" }, ({ success: res }) =>
        match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
            if (exitCode !== 0) {
              process.stderr.write(
                `[harness:omnigraph] force-unlock failed for ${lockId} (exitCode=${exitCode}): ${stderr || stdout}\n`,
              )
              return false
            }
            return true
          })
          .with({ _tag: "TimedOut" }, ({ stderr }) => {
            process.stderr.write(
              `[harness:omnigraph] force-unlock timed out for ${lockId}: ${stderr}\n`,
            )
            return false
          })
          .with({ _tag: "Signaled" }, ({ signal, stderr }) => {
            process.stderr.write(
              `[harness:omnigraph] force-unlock killed by ${signal} for ${lockId}: ${stderr}\n`,
            )
            return false
          })
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => {
            process.stderr.write(
              `[harness:omnigraph] force-unlock spawn failed for ${lockId}: ${spawnError}\n`,
            )
            return false
          })
          .exhaustive(),
      )
      .exhaustive()
    if (!unlockOk) {
      return { ok: false, reason: `force-unlock-failed:${lockId}` }
    }
  }
  return { ok: true }
}

export const buildOmnigraphClusterKillArgs = (
  clusterRootDir: string,
): readonly [string, ReadonlyArray<string>] => {
  const escaped = clusterRootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return ["pkill", ["-f", `omnigraph-server.*--cluster file://${escaped}(\\s|$)`]]
}

const decodeOmnigraphServerMeta = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema),
)

export const stopStaleOmnigraphClusterBeforeDelete = (
  clusterRootDir: string,
  serverPid: number | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
  isPidAlive: (pid: number) => boolean = isProcessPidAlive,
): boolean => {
  const [killBin, killArgs] = buildOmnigraphClusterKillArgs(clusterRootDir)
  const killResult = Result.try({
    try: () => {
      const killRes = hostIo.execFileSync(killBin, [...killArgs], { timeoutMs: 5_000 })
      return match(killRes)
        .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
          if (exitCode !== 0 && exitCode !== 1) {
            process.stderr.write(
              `[harness:omnigraph] Warning: pkill returned exitCode=${exitCode}: ${stderr || stdout}\n`,
            )
            return false
          }
          return true
        })
        .with({ _tag: "TimedOut" }, ({ stderr }) => {
          process.stderr.write(`[harness:omnigraph] Warning: pkill timed out: ${stderr}\n`)
          return false
        })
        .with({ _tag: "Signaled" }, ({ signal, stderr }) => {
          process.stderr.write(`[harness:omnigraph] Warning: pkill killed by ${signal}: ${stderr}\n`)
          return false
        })
        .with({ _tag: "SpawnFailed" }, ({ spawnError }) => {
          process.stderr.write(`[harness:omnigraph] Warning: pkill spawn failed: ${spawnError}\n`)
          return false
        })
        .exhaustive()
    },
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

export function ensureLocalOmnigraphReady(repoRoot: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
    const canonicalRepoRoot = resolveCanonicalRepoRoot(clusterRepoRoot, nodeSyncHostIo)
    const clusterRootDir = resolveOmnigraphClusterDir(clusterRepoRoot, nodeSyncHostIo)
    const defaultPort = deriveRepoOmnigraphPort(canonicalRepoRoot, nodeSyncHostIo)
    const explicitEnvUrl =
      process.env.OMNIGRAPH_URL && process.env.OMNIGRAPH_URL !== "http://127.0.0.1:8080"
        ? process.env.OMNIGRAPH_URL
        : undefined
    if (explicitEnvUrl !== undefined && !isLoopbackOmnigraphUrl(explicitEnvUrl)) {
      process.stderr.write(
        `[harness:omnigraph] Refusing non-loopback Omnigraph URL/bind host: ${explicitEnvUrl}\n`,
      )
      return false
    }

    const candidateConfigDir = resolveOmnigraphConfigDir(repoRoot, canonicalRepoRoot)
    const configDir = nodeSyncHostIo.existsSync(join(candidateConfigDir, "cluster.yaml"))
      ? candidateConfigDir
      : join(CLI_REPO_ROOT, "libs", "harness", "graph")
    const homeBin = join(process.env.HOME ?? "/root", ".local", "bin")
    const omnigraphBin = join(homeBin, "omnigraph")
    const omnigraphServerBin = join(homeBin, "omnigraph-server")
    const clusterYamlPath = join(configDir, "cluster.yaml")
    let hasPolicies = false
    if (nodeSyncHostIo.existsSync(clusterYamlPath)) {
      const yamlRead = match(Result.try(() => nodeSyncHostIo.readTextSync(clusterYamlPath)))
        .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, content: success }))
        .with({ _tag: "Failure" }, ({ failure }) => {
          process.stderr.write(
            `[harness:omnigraph] Error: failed to read ${clusterYamlPath}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
          )
          return { ok: false as const, content: "" }
        })
        .exhaustive()
      if (!yamlRead.ok) {
        return false
      }
      hasPolicies = clusterYamlDeclaresPolicies(yamlRead.content)
    }

    type SetupRes = { readonly ok: true; readonly pid: number; readonly appliedCluster: boolean } | { readonly ok: false }
    return yield* Effect.acquireUseRelease(
      acquireOmnigraphClusterLockEffect(clusterRootDir),
      (lockHandle) =>
        Effect.gen(function* () {
          if (lockHandle === undefined) {
            process.stderr.write(`[harness:omnigraph] Failed to acquire cluster startup lock for ${clusterRootDir}\n`)
            return false
          }

          let serverMeta: OmnigraphServerMeta | undefined
          let serverJsonCorruptOrUnreadable = false
          const serverJsonPath = join(clusterRootDir, "server.json")
          if (nodeSyncHostIo.existsSync(serverJsonPath)) {
            const rawMetaOutcome = match(Result.try(() => nodeSyncHostIo.readTextSync(serverJsonPath)))
              .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, raw: success }))
              .with({ _tag: "Failure" }, ({ failure }) => {
                process.stderr.write(
                  `[harness:omnigraph] Warning: failed to read ${serverJsonPath}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
                )
                return { ok: false as const, raw: "" }
              })
              .exhaustive()
            if (!rawMetaOutcome.ok) {
              serverJsonCorruptOrUnreadable = true
            } else {
              serverMeta = match(decodeOmnigraphServerMeta(rawMetaOutcome.raw))
                .with({ _tag: "Some" }, ({ value }) => value)
                .with({ _tag: "None" }, () => {
                  serverJsonCorruptOrUnreadable = true
                  process.stderr.write(
                    `[harness:omnigraph] Warning: failed to decode ${serverJsonPath} as OmnigraphServerMeta JSON\n`,
                  )
                  return undefined
                })
                .exhaustive()
            }
          }

          const targetBaseUrl =
            explicitEnvUrl ??
            (serverMeta?.canonicalRepoRoot === canonicalRepoRoot && serverMeta?.baseUrl
              ? serverMeta.baseUrl
              : `http://127.0.0.1:${defaultPort}`)
          if (!isLoopbackOmnigraphUrl(targetBaseUrl)) {
            process.stderr.write(
              `[harness:omnigraph] Refusing non-loopback Omnigraph URL/bind host: ${targetBaseUrl}\n`,
            )
            return false
          }

          const serverPid = serverMeta?.pid
          const serverAlive =
            typeof serverPid === "number" &&
            Number.isInteger(serverPid) &&
            serverPid > 1 &&
            isProcessPidAlive(serverPid) &&
            isSafeOmnigraphPidToKill(serverPid, clusterRootDir)
          const drift = yield* evaluateClusterConfigDrift(clusterRootDir, configDir, serverAlive)

          const driftHandled = yield* match(drift.action)
            .with({ _tag: "RequiresCleanRebuild" }, () =>
              Effect.gen(function* () {
                if (
                  resolve(repoRoot) !== resolve(canonicalRepoRoot) &&
                  process.env.HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD !== "1"
                ) {
                  const probe = yield* probeOmnigraphServerReady(targetBaseUrl)
                  const alreadyReady = match(probe)
                    .with({ _tag: "Ready" }, () => true)
                    .with({ _tag: "NotReady" }, () => false)
                    .exhaustive()
                  if (alreadyReady) {
                    process.stderr.write(
                      `[harness:omnigraph] Warning: skipping destructive RequiresCleanRebuild of shared canonical cluster '${clusterRootDir}' from linked worktree '${repoRoot}'; reusing running server.\n`,
                    )
                    return { ok: true as const, alreadyReady: true as const, applyCluster: false }
                  }
                  process.stderr.write(
                    `[harness:omnigraph] Error: refusing destructive RequiresCleanRebuild of shared canonical cluster '${clusterRootDir}' from linked worktree '${repoRoot}' (canonical: '${canonicalRepoRoot}'). Set HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD=1 or rebuild from canonical repo.\n`,
                  )
                  return { ok: false as const, applyCluster: false }
                }
                if (!(yield* killOmnigraphServerPidIfAlive(serverPid, clusterRootDir, "clean rebuild"))) {
                  return { ok: false as const, applyCluster: false }
                }
                const stoppedBeforeDelete = stopStaleOmnigraphClusterBeforeDelete(
                  clusterRootDir,
                  typeof serverPid === "number" && Number.isInteger(serverPid) && serverPid > 1
                    ? serverPid
                    : undefined,
                )
                if (!stoppedBeforeDelete) {
                  return { ok: false as const, applyCluster: false }
                }
                yield* Effect.sleep("300 millis")
                const rmOk = yield* Effect.try({
                  try: () => {
                    nodeSyncHostIo.rmRecursiveSync(clusterRootDir)
                    return true
                  },
                  catch: (err) => {
                    process.stderr.write(
                      `[harness:omnigraph] Error: failed to remove drifted cluster dir '${clusterRootDir}': ${err instanceof Error ? err.message : String(err)}\n`,
                    )
                    return false
                  },
                }).pipe(Effect.orElseSucceed(() => false))
                if (!rmOk) {
                  return { ok: false as const, applyCluster: false }
                }
                if (nodeSyncHostIo.existsSync(join(clusterRootDir, "graphs", "harness.omni"))) {
                  process.stderr.write(
                    `[harness:omnigraph] Error: drifted cluster graph still exists at '${join(clusterRootDir, "graphs", "harness.omni")}' after teardown\n`,
                  )
                  return { ok: false as const, applyCluster: false }
                }
                return { ok: true as const, applyCluster: true }
              }),
            )
            .with({ _tag: "LiveClusterApply" }, () =>
              Effect.gen(function* () {
                const stopped =
                  serverPid === undefined && serverJsonCorruptOrUnreadable
                    ? stopStaleOmnigraphClusterBeforeDelete(clusterRootDir, undefined)
                    : yield* killOmnigraphServerPidIfAlive(serverPid, clusterRootDir, "live cluster apply")
                return { ok: stopped, applyCluster: stopped }
              }),
            )
            .with({ _tag: "NoOp" }, () =>
              Effect.gen(function* () {
                if (serverJsonCorruptOrUnreadable) {
                  const stopped = stopStaleOmnigraphClusterBeforeDelete(clusterRootDir, undefined)
                  if (!stopped) {
                    return { ok: false as const, applyCluster: false }
                  }
                }
                const belongsToThisRepo =
                  explicitEnvUrl !== undefined || serverMeta?.canonicalRepoRoot === canonicalRepoRoot
                if (belongsToThisRepo) {
                  const probe = yield* probeOmnigraphServerReady(targetBaseUrl)
                  const alreadyReady = match(probe)
                    .with({ _tag: "Ready" }, () => true)
                    .with({ _tag: "NotReady" }, () => false)
                    .exhaustive()
                  if (alreadyReady) {
                    return { ok: true as const, alreadyReady: true as const, applyCluster: false }
                  }
                }
                return { ok: true as const, applyCluster: false }
              }),
            )
            .exhaustive()

          if (!driftHandled.ok) {
            return false
          }
          if ("alreadyReady" in driftHandled && driftHandled.alreadyReady) {
            return true
          }

          if (!nodeSyncHostIo.existsSync(omnigraphBin) || !nodeSyncHostIo.existsSync(omnigraphServerBin)) {
            process.stderr.write(
              `[harness:omnigraph] Missing omnigraph binaries (${omnigraphBin}, ${omnigraphServerBin}). Install omnigraph v0.14.0 into ~/.local/bin before retrying.\n`,
            )
            return false
          }

          let appliedCluster = false
          const setupRes: SetupRes = yield* Effect.try({
            try: (): SetupRes => {
              if (!nodeSyncHostIo.existsSync(clusterRootDir)) {
                nodeSyncHostIo.mkdirRecursiveSync(clusterRootDir)
              }
              const tokensOutcome = hasPolicies
                ? match(ensureOmnigraphEndpointTokens(clusterRootDir))
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
              const preUnlock = unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)
              if (!preUnlock.ok) {
                return { ok: false }
              }
              const graphOmniDir = join(clusterRootDir, "graphs", "harness.omni")
              if (driftHandled.applyCluster || !nodeSyncHostIo.existsSync(graphOmniDir)) {
                const outRes = nodeSyncHostIo.execFileSync(
                  omnigraphBin,
                  ["cluster", "apply", "--target", `file://${clusterRootDir}`, "--config", configDir, "--as", "harness-cli", "--json"],
                  { cwd: clusterRepoRoot, timeoutMs: 30_000 },
                )
                const applyStdout = match(outRes)
                  .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
                    if (exitCode !== 0) {
                      process.stderr.write(`[harness:omnigraph] Local omnigraph cluster apply failed (exitCode=${exitCode}): ${stderr || stdout || "unknown error"}\n`)
                      return undefined
                    }
                    return stdout
                  })
                  .with({ _tag: "TimedOut" }, ({ stderr }) => { process.stderr.write(`[harness:omnigraph] Local omnigraph cluster apply timed out: ${stderr}\n`); return undefined })
                  .with({ _tag: "Signaled" }, ({ signal, stderr }) => { process.stderr.write(`[harness:omnigraph] Local omnigraph cluster apply killed by ${signal}: ${stderr}\n`); return undefined })
                  .with({ _tag: "SpawnFailed" }, ({ spawnError }) => { process.stderr.write(`[harness:omnigraph] Local omnigraph cluster apply spawn failed: ${spawnError}\n`); return undefined })
                  .exhaustive()
                if (applyStdout === undefined) return { ok: false }
                if (!unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir, applyStdout).ok) return { ok: false }
                appliedCluster = true
              }
              if (!unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir).ok) return { ok: false }
              const bindHostPort = targetBaseUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? `127.0.0.1:${defaultPort}`
              if (!hasPolicies) {
                process.stderr.write(
                  "[harness:omnigraph] Warning: spawning omnigraph-server with --unauthenticated because cluster.yaml declares no policies:\n",
                )
              }
              const spawnArgs = ["--cluster", `file://${clusterRootDir}`, "--bind", bindHostPort, ...(hasPolicies ? [] : ["--unauthenticated"])]
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
                OMNIGRAPH_EMBEDDING_API_KEY: process.env.OMNIGRAPH_EMBEDDING_API_KEY ?? DEFAULT_EMBEDDING_API_KEY,
                ...(process.env.OMNIGRAPH_EMBEDDINGS_MOCK !== undefined
                  ? { OMNIGRAPH_EMBEDDINGS_MOCK: process.env.OMNIGRAPH_EMBEDDINGS_MOCK }
                  : !hasExplicitEmbeddingKey
                    ? { OMNIGRAPH_EMBEDDINGS_MOCK: DEFAULT_EMBEDDINGS_MOCK }
                    : {}),
                ...(tokens !== undefined
                  ? { OMNIGRAPH_SERVER_BEARER_TOKENS_JSON: JSON.stringify({ "harness-cli": tokens.cliToken, "agent-mcp": tokens.mcpToken }) }
                  : {}),
              }
              if (hasExplicitEmbeddingKey && process.env.OMNIGRAPH_EMBEDDINGS_MOCK === undefined) {
                delete spawnEnv.OMNIGRAPH_EMBEDDINGS_MOCK
              }
              const spawnRes = nodeSyncHostIo.spawnDetached(omnigraphServerBin, spawnArgs, {
                cwd: clusterRepoRoot,
                stderrLogPath: join(clusterRootDir, "omnigraph-spawn.stderr.log"),
                env: spawnEnv,
              })
              return match(spawnRes)
                .with({ _tag: "SpawnFailed" }, ({ spawnError }): SetupRes => {
                  process.stderr.write(`[harness:omnigraph] Failed to spawn omnigraph-server: ${spawnError}\n`)
                  return { ok: false }
                })
                .with({ _tag: "Spawned" }, ({ pid }): SetupRes => ({ ok: true, pid, appliedCluster }))
                .exhaustive()
            },
            catch: (err): SetupRes => {
              process.stderr.write(`[harness:omnigraph] Local omnigraph setup/spawn failed: ${err instanceof Error ? err.message : String(err)}\n`)
              return { ok: false }
            },
          }).pipe(Effect.orElseSucceed((): SetupRes => ({ ok: false })))

          const canFallbackProbe = match(drift.action)
            .with({ _tag: "RequiresCleanRebuild" }, () => false)
            .with({ _tag: "LiveClusterApply" }, { _tag: "NoOp" }, () => true)
            .exhaustive()

          if (!setupRes.ok) {
            if (explicitEnvUrl !== undefined && canFallbackProbe) {
              for (let i = 0; i < 5; i++) {
                const probe = yield* probeOmnigraphServerReady(targetBaseUrl)
                const isReady = match(probe)
                  .with({ _tag: "Ready" }, () => true)
                  .with({ _tag: "NotReady" }, () => false)
                  .exhaustive()
                if (isReady) return true
                yield* Effect.sleep("100 millis")
              }
            }
            return false
          }

          let lastFailureReason = "unknown"
          for (let i = 0; i < 30; i++) {
            if (!isProcessPidAlive(setupRes.pid)) {
              lastFailureReason = `spawned omnigraph-server PID ${setupRes.pid} exited prematurely`
              break
            }
            const probe = yield* probeOmnigraphServerReady(targetBaseUrl)
            const isReady = match(probe)
              .with({ _tag: "Ready" }, () => true)
              .with({ _tag: "NotReady" }, ({ reason }) => { lastFailureReason = reason; return false })
              .exhaustive()
            if (isReady) {
              if (setupRes.appliedCluster) {
                writeClusterDriftReceipts(clusterRootDir, drift.expectedStamp, configDir)
              }
              const parsedPort = Result.getOrElse(
                Result.try(() => Number(new URL(targetBaseUrl).port) || defaultPort),
                () => defaultPort,
              )
              const metaWriteRes = writeServerMetaAtomic(clusterRootDir, {
                pid: OmnigraphProcessId.make(setupRes.pid),
                port: OmnigraphTcpPort.make(parsedPort),
                baseUrl: OmnigraphBaseUrl.make(targetBaseUrl),
                canonicalRepoRoot: WorkspaceFilePath.make(canonicalRepoRoot),
                updatedAt: OmnigraphIsoTimestamp.make(new Date().toISOString()),
              })
              const metaWriteOk = yield* match(metaWriteRes)
                .with({ _tag: "Success" }, () => Effect.succeed(true))
                .with({ _tag: "Failure" }, ({ failure }) =>
                  Effect.gen(function* () {
                    process.stderr.write(
                      `[harness:omnigraph] Error: failed to write server.json: ${failure.message}\n`,
                    )
                    yield* killOmnigraphServerPidIfAlive(setupRes.pid, clusterRootDir, "server.json write failure")
                    return false
                  }),
                )
                .exhaustive()
              return metaWriteOk
            }
            yield* Effect.sleep("100 millis")
          }
          yield* killOmnigraphServerPidIfAlive(setupRes.pid, clusterRootDir, "readyz timeout")
          process.stderr.write(`[harness:omnigraph] Omnigraph server did not become ready at ${targetBaseUrl}/readyz: ${lastFailureReason}\n`)
          return false
        }),
      (lockHandle) => Effect.sync(() => releaseOmnigraphClusterLock(lockHandle)),
    )
  })
}
