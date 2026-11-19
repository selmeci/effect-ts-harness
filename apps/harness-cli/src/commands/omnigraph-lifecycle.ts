import { join, resolve } from "node:path"
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
  stopStaleOmnigraphClusterBeforeDelete,
  unlinkServerMetaIfExists,
  writeClusterDriftReceipts,
  writeServerMetaAtomic,
} from "./omnigraph-auth-and-drift.js"
import {
  clearPendingWorkflowRestoreJournal,
  matchExecSyncStdout,
  readPendingWorkflowRestoreJournal,
  runWorkflowBackupBeforeRebuild,
  runWorkflowRestoreAfterRebuild,
  type UnlockClusterResult,
  unlockOmnigraphClusterIfNeeded,
  withClusterDaemonLockIfGit,
  type WorkflowBeforeRebuildResult,
  writePendingWorkflowRestoreJournal,
} from "./omnigraph-workflow-backup.js"
import {
  buildOmnigraphClusterKillArgs,
  CLI_REPO_ROOT,
  findWorkspaceRoot,
  resolveClusterRepoRoot,
} from "./repo-path.js"

const DEFAULT_EMBEDDING_API_KEY = "ollama-local"
const DEFAULT_EMBEDDINGS_MOCK = "1"

export {
  buildOmnigraphClusterKillArgs,
  CLI_REPO_ROOT,
  findWorkspaceRoot,
  isLoopbackOmnigraphUrl,
  isProcessPidAlive,
  isSafeOmnigraphPidToKill,
  isValidLockId,
  resolveClusterRepoRoot,
  stopStaleOmnigraphClusterBeforeDelete,
  type UnlockClusterResult,
  unlockOmnigraphClusterIfNeeded,
}

const decodeOmnigraphServerMeta = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema),
)

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

    type SetupRes =
      | { readonly ok: true; readonly pid: number; readonly appliedCluster: boolean }
      | { readonly ok: false }
    return yield* Effect.acquireUseRelease(
      acquireOmnigraphClusterLockEffect(clusterRootDir),
      (lockHandle) =>
        Effect.gen(function* () {
          if (lockHandle === undefined) {
            process.stderr.write(
              `[harness:omnigraph] Failed to acquire cluster startup lock for ${clusterRootDir}\n`,
            )
            return false
          }

          const pendingState = match(readPendingWorkflowRestoreJournal(clusterRepoRoot))
            .with({ _tag: "None" }, () => ({ ok: true as const, backup: undefined }))
            .with({ _tag: "Some" }, ({ backup }) => ({ ok: true as const, backup }))
            .with({ _tag: "Invalid" }, ({ reason }) => {
              process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
              return { ok: false as const, backup: undefined }
            })
            .exhaustive()
          if (!pendingState.ok) {
            return false
          }
          const pendingBackup = pendingState.backup

          let serverMeta: OmnigraphServerMeta | undefined
          let serverJsonCorruptOrUnreadable = false
          const serverJsonPath = join(clusterRootDir, "server.json")
          if (nodeSyncHostIo.existsSync(serverJsonPath)) {
            match(Result.try(() => nodeSyncHostIo.readTextSync(serverJsonPath)))
              .with({ _tag: "Failure" }, ({ failure }) => {
                serverJsonCorruptOrUnreadable = true
                process.stderr.write(
                  `[harness:omnigraph] Warning: failed to read ${serverJsonPath}: ${failure instanceof Error ? failure.message : String(failure)}\n`,
                )
              })
              .with({ _tag: "Success" }, ({ success }) => {
                match(decodeOmnigraphServerMeta(success))
                  .with({ _tag: "Some" }, ({ value }) => {
                    serverMeta = value
                  })
                  .with({ _tag: "None" }, () => {
                    serverJsonCorruptOrUnreadable = true
                    process.stderr.write(
                      `[harness:omnigraph] Warning: failed to decode ${serverJsonPath} as OmnigraphServerMeta JSON\n`,
                    )
                  })
                  .exhaustive()
              })
              .exhaustive()
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

          const restorePendingOnLiveServer = (
            baseUrl: string,
            backup: WorkflowBeforeRebuildResult | undefined,
          ): Effect.Effect<boolean> => {
            if (backup === undefined) {
              return Effect.succeed(true)
            }
            return runWorkflowRestoreAfterRebuild({
              clusterRepoRoot,
              clusterRootDir,
              baseUrl,
              backup,
            }).pipe(
              Effect.tap((ok) =>
                Effect.sync(() => {
                  if (ok) clearPendingWorkflowRestoreJournal(clusterRepoRoot)
                }),
              ),
            )
          }

          const preLockDecision = yield* match(drift.action)
            .with({ _tag: "RequiresCleanRebuild" }, () =>
              Effect.gen(function* () {
                if (
                  resolve(clusterRepoRoot) !== resolve(canonicalRepoRoot) &&
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
                    const restored = yield* restorePendingOnLiveServer(targetBaseUrl, pendingBackup)
                    return { _tag: "Done" as const, ok: restored }
                  }
                  process.stderr.write(
                    `[harness:omnigraph] Error: refusing destructive RequiresCleanRebuild of shared canonical cluster '${clusterRootDir}' from linked worktree '${repoRoot}' (canonical: '${canonicalRepoRoot}'). Set HARNESS_ALLOW_WORKTREE_CLUSTER_REBUILD=1 or rebuild from canonical repo.\n`,
                  )
                  return { _tag: "Done" as const, ok: false }
                }
                return { _tag: "Continue" as const }
              }),
            )
            .with({ _tag: "NoOp" }, () =>
              Effect.gen(function* () {
                const belongsToThisRepo =
                  explicitEnvUrl !== undefined ||
                  serverMeta?.canonicalRepoRoot === canonicalRepoRoot
                if (!serverJsonCorruptOrUnreadable && belongsToThisRepo) {
                  const probe = yield* probeOmnigraphServerReady(targetBaseUrl)
                  const alreadyReady = match(probe)
                    .with({ _tag: "Ready" }, () => true)
                    .with({ _tag: "NotReady" }, () => false)
                    .exhaustive()
                  if (alreadyReady) {
                    const restored = yield* restorePendingOnLiveServer(targetBaseUrl, pendingBackup)
                    return { _tag: "Done" as const, ok: restored }
                  }
                }
                return { _tag: "Continue" as const }
              }),
            )
            .with({ _tag: "LiveClusterApply" }, () => Effect.succeed({ _tag: "Continue" as const }))
            .exhaustive()

          const preLockEarly = match(preLockDecision)
            .with({ _tag: "Done" }, ({ ok }) => ok)
            .with({ _tag: "Continue" }, () => undefined)
            .exhaustive()
          if (preLockEarly !== undefined) {
            return preLockEarly
          }

          return yield* withClusterDaemonLockIfGit(
            clusterRepoRoot,
            Effect.gen(function* () {
              let spawnedPidToCleanup: number | undefined = undefined
              const cleanupSpawned = (reason: string): Effect.Effect<void> =>
                Effect.gen(function* () {
                  const pid = spawnedPidToCleanup
                  spawnedPidToCleanup = undefined
                  if (pid !== undefined) {
                    yield* killOmnigraphServerPidIfAlive(pid, clusterRootDir, reason)
                  }
                  unlinkServerMetaIfExists(clusterRootDir)
                })

              const body = Effect.gen(function* () {
                const driftHandled = yield* match(drift.action)
                  .with({ _tag: "RequiresCleanRebuild" }, () =>
                    Effect.gen(function* () {
                      const backupOutcome =
                        pendingBackup !== undefined
                          ? pendingBackup
                          : yield* runWorkflowBackupBeforeRebuild({
                              clusterRepoRoot,
                              clusterRootDir,
                              targetBaseUrl,
                              omnigraphBin,
                              serverAlive,
                            })
                      const backupFailed = match(backupOutcome)
                        .with({ _tag: "Failed" }, () => true)
                        .with({ _tag: "Skipped" }, { _tag: "BackedUp" }, () => false)
                        .exhaustive()
                      if (backupFailed) {
                        return { ok: false as const, applyCluster: false }
                      }
                      if (
                        !(yield* killOmnigraphServerPidIfAlive(
                          serverPid,
                          clusterRootDir,
                          "clean rebuild",
                        ))
                      ) {
                        return { ok: false as const, applyCluster: false }
                      }
                      const stoppedBeforeDelete = stopStaleOmnigraphClusterBeforeDelete(
                        clusterRootDir,
                        typeof serverPid === "number" &&
                          Number.isInteger(serverPid) &&
                          serverPid > 1
                          ? serverPid
                          : undefined,
                      )
                      if (!stoppedBeforeDelete) {
                        return { ok: false as const, applyCluster: false }
                      }
                      const journalOk = match(backupOutcome)
                        .with({ _tag: "BackedUp" }, (backedUp) =>
                          pendingBackup !== undefined
                            ? true
                            : match(writePendingWorkflowRestoreJournal(clusterRepoRoot, backedUp))
                                .with({ _tag: "Success" }, () => true)
                                .with({ _tag: "Failure" }, ({ failure }) => {
                                  process.stderr.write(
                                    `[harness:omnigraph] Error: failed to write pending-workflow-restore.json: ${failure}\n`,
                                  )
                                  return false
                                })
                                .exhaustive(),
                        )
                        .with({ _tag: "Skipped" }, { _tag: "Failed" }, () => true)
                        .exhaustive()
                      if (!journalOk) {
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
                      if (
                        nodeSyncHostIo.existsSync(join(clusterRootDir, "graphs", "harness.omni"))
                      ) {
                        process.stderr.write(
                          `[harness:omnigraph] Error: drifted cluster graph still exists at '${join(clusterRootDir, "graphs", "harness.omni")}' after teardown\n`,
                        )
                        return { ok: false as const, applyCluster: false }
                      }
                      return {
                        ok: true as const,
                        applyCluster: true,
                        workflowBackup: backupOutcome,
                      }
                    }),
                  )
                  .with({ _tag: "LiveClusterApply" }, () =>
                    Effect.gen(function* () {
                      const stopped =
                        serverPid === undefined && serverJsonCorruptOrUnreadable
                          ? stopStaleOmnigraphClusterBeforeDelete(clusterRootDir, undefined)
                          : yield* killOmnigraphServerPidIfAlive(
                              serverPid,
                              clusterRootDir,
                              "live cluster apply",
                            )
                      return { ok: stopped, applyCluster: stopped, workflowBackup: pendingBackup }
                    }),
                  )
                  .with({ _tag: "NoOp" }, () =>
                    Effect.sync(() => {
                      if (serverJsonCorruptOrUnreadable) {
                        const stopped = stopStaleOmnigraphClusterBeforeDelete(
                          clusterRootDir,
                          undefined,
                        )
                        if (!stopped) {
                          return { ok: false as const, applyCluster: false }
                        }
                      }
                      return {
                        ok: true as const,
                        applyCluster: false,
                        workflowBackup: pendingBackup,
                      }
                    }),
                  )
                  .exhaustive()

                if (!driftHandled.ok) {
                  return false
                }

                if (
                  !nodeSyncHostIo.existsSync(omnigraphBin) ||
                  !nodeSyncHostIo.existsSync(omnigraphServerBin)
                ) {
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
                        [
                          "cluster",
                          "apply",
                          "--target",
                          `file://${clusterRootDir}`,
                          "--config",
                          configDir,
                          "--as",
                          "harness-cli",
                          "--json",
                        ],
                        { cwd: clusterRepoRoot, timeoutMs: 30_000 },
                      )
                      const applyStdout = matchExecSyncStdout(
                        "Local omnigraph cluster apply failed",
                        outRes,
                      )
                      if (applyStdout === undefined) return { ok: false }
                      if (
                        !unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir, applyStdout)
                          .ok
                      )
                        return { ok: false }
                      appliedCluster = true
                    }
                    if (!unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir).ok)
                      return { ok: false }
                    const bindHostPort =
                      targetBaseUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? `127.0.0.1:${defaultPort}`
                    if (!hasPolicies) {
                      process.stderr.write(
                        "[harness:omnigraph] Warning: spawning omnigraph-server with --unauthenticated because cluster.yaml declares no policies:\n",
                      )
                    }
                    const spawnArgs = [
                      "--cluster",
                      `file://${clusterRootDir}`,
                      "--bind",
                      bindHostPort,
                      ...(hasPolicies ? [] : ["--unauthenticated"]),
                    ]
                    const hasExplicitEmbeddingKey =
                      typeof process.env.OMNIGRAPH_EMBEDDING_API_KEY === "string" &&
                      process.env.OMNIGRAPH_EMBEDDING_API_KEY.length > 0
                    if (
                      process.env.OMNIGRAPH_EMBEDDINGS_MOCK === undefined &&
                      !hasExplicitEmbeddingKey
                    ) {
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
                    const spawnRes = nodeSyncHostIo.spawnDetached(omnigraphServerBin, spawnArgs, {
                      cwd: clusterRepoRoot,
                      stderrLogPath: join(clusterRootDir, "omnigraph-spawn.stderr.log"),
                      env: spawnEnv,
                    })
                    return match(spawnRes)
                      .with({ _tag: "SpawnFailed" }, ({ spawnError }): SetupRes => {
                        process.stderr.write(
                          `[harness:omnigraph] Failed to spawn omnigraph-server: ${spawnError}\n`,
                        )
                        return { ok: false }
                      })
                      .with({ _tag: "Spawned" }, ({ pid }): SetupRes => ({
                        ok: true,
                        pid,
                        appliedCluster,
                      }))
                      .exhaustive()
                  },
                  catch: (err): SetupRes => {
                    process.stderr.write(
                      `[harness:omnigraph] Local omnigraph setup/spawn failed: ${err instanceof Error ? err.message : String(err)}\n`,
                    )
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
                      if (isReady) {
                        return yield* restorePendingOnLiveServer(
                          targetBaseUrl,
                          driftHandled.workflowBackup,
                        )
                      }
                      yield* Effect.sleep("100 millis")
                    }
                  }
                  return false
                }

                spawnedPidToCleanup = setupRes.pid
                let lastFailureReason = "unknown"
                for (let i = 0; i < 30; i++) {
                  if (!isProcessPidAlive(setupRes.pid)) {
                    lastFailureReason = `spawned omnigraph-server PID ${setupRes.pid} exited prematurely`
                    break
                  }
                  const probe = yield* probeOmnigraphServerReady(targetBaseUrl)
                  const isReady = match(probe)
                    .with({ _tag: "Ready" }, () => true)
                    .with({ _tag: "NotReady" }, ({ reason }) => {
                      lastFailureReason = reason
                      return false
                    })
                    .exhaustive()
                  if (isReady) {
                    const restoreOk = yield* restorePendingOnLiveServer(
                      targetBaseUrl,
                      driftHandled.workflowBackup,
                    )
                    if (!restoreOk) {
                      yield* cleanupSpawned("workflow backup restore failure")
                      return false
                    }
                    const parsedPort = Result.getOrElse(
                      Result.try(() => Number(new URL(targetBaseUrl).port) || defaultPort),
                      () => defaultPort,
                    )
                    const metaWriteErr = match(
                      writeServerMetaAtomic(clusterRootDir, {
                        pid: OmnigraphProcessId.make(setupRes.pid),
                        port: OmnigraphTcpPort.make(parsedPort),
                        baseUrl: OmnigraphBaseUrl.make(targetBaseUrl),
                        canonicalRepoRoot: WorkspaceFilePath.make(canonicalRepoRoot),
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
                      yield* cleanupSpawned("server.json write failure")
                      return false
                    }
                    if (setupRes.appliedCluster) {
                      writeClusterDriftReceipts(clusterRootDir, drift.expectedStamp, configDir)
                    }
                    spawnedPidToCleanup = undefined
                    return true
                  }
                  yield* Effect.sleep("100 millis")
                }
                yield* cleanupSpawned("readyz timeout")
                process.stderr.write(
                  `[harness:omnigraph] Omnigraph server did not become ready at ${targetBaseUrl}/readyz: ${lastFailureReason}\n`,
                )
                return false
              })

              return yield* body.pipe(Effect.onInterrupt(() => cleanupSpawned("fiber interrupt")))
            }),
          )
        }),
      (lockHandle) => Effect.sync(() => releaseOmnigraphClusterLock(lockHandle)),
    )
  })
}
