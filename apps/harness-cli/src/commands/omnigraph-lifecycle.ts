import { join, resolve } from "node:path"
import { Effect } from "effect"
import { match } from "ts-pattern"
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import {
  evaluateClusterConfigDrift,
  killOmnigraphServerPidIfAlive,
  resolveOmnigraphConfigDir,
  stopStaleOmnigraphClusterBeforeDelete,
  withOmnigraphClusterStartupLock,
} from "./omnigraph-auth-and-drift.js"
import {
  cleanupSpawnedOmnigraphServer,
  readClusterPoliciesFlag,
  readOmnigraphServerMetaChecked,
  restorePendingWorkflowOnLiveServer,
  setupAndSpawnOmnigraphCluster,
  waitForSpawnedOmnigraphReady,
} from "./omnigraph-lifecycle-setup.js"
import {
  isLoopbackOmnigraphUrl,
  isProcessPidAlive,
  isSafeOmnigraphPidToKill,
  isValidLockId,
  probeOmnigraphServerReady,
} from "./omnigraph-safety-helpers.js"
import {
  computeSha256Hex,
  readClusterConfigStampDigest,
  readPendingWorkflowRestoreJournal,
  runWorkflowBackupBeforeRebuild,
  type UnlockClusterResult,
  unlockOmnigraphClusterIfNeeded,
  withClusterDaemonLockIfGit,
  writePendingWorkflowRestoreJournal,
} from "./omnigraph-workflow-backup.js"
import {
  buildOmnigraphClusterKillArgs,
  CLI_REPO_ROOT,
  findWorkspaceRoot,
  resolveClusterRepoRoot,
} from "./repo-path.js"

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
    const policiesRes = readClusterPoliciesFlag(join(configDir, "cluster.yaml"))
    if (!policiesRes.ok) {
      return false
    }
    const hasPolicies = policiesRes.hasPolicies

    const lifecycleEffect = Effect.gen(function* () {
      const preRebuildConfigStamp = readClusterConfigStampDigest(clusterRootDir)
      const pendingState = match(
        readPendingWorkflowRestoreJournal(clusterRepoRoot, clusterRootDir, {
          allowPostRebuildConfigStamp: true,
        }),
      )
        .with({ _tag: "None" }, () => ({ ok: true as const, journal: undefined }))
        .with({ _tag: "Some" }, (found) => ({ ok: true as const, journal: found }))
        .with({ _tag: "Invalid" }, ({ reason }) => {
          process.stderr.write(`[harness:omnigraph] Error: ${reason}\n`)
          return { ok: false as const, journal: undefined }
        })
        .exhaustive()
      if (!pendingState.ok) {
        return false
      }
      const pendingJournal = pendingState.journal
      const pendingBackup = pendingJournal?.backup

      const metaRead = readOmnigraphServerMetaChecked(clusterRootDir)
      const serverMeta = metaRead.serverMeta
      const serverJsonCorruptOrUnreadable = metaRead.corruptOrUnreadable

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

      const preRebuildStampOk = match(drift.action)
        .with(
          { _tag: "RequiresCleanRebuild" },
          () =>
            pendingJournal === undefined ||
            pendingJournal.preRebuildConfigStamp === preRebuildConfigStamp ||
            (preRebuildConfigStamp === null &&
              !nodeSyncHostIo.existsSync(join(clusterRootDir, "graphs", "harness-workflows.omni"))),
        )
        .with(
          { _tag: "LiveClusterApply" },
          { _tag: "NoOp" },
          () =>
            pendingJournal === undefined ||
            pendingJournal.expectedPostRebuildConfigStamp === null ||
            pendingJournal.expectedPostRebuildConfigStamp === undefined ||
            preRebuildConfigStamp === pendingJournal.expectedPostRebuildConfigStamp,
        )
        .exhaustive()
      if (!preRebuildStampOk) {
        process.stderr.write(
          `[harness:omnigraph] Error: pending-workflow-restore.json config stamp mismatch for ${clusterRootDir}\n`,
        )
        return false
      }

      const runLockedLiveRestore = (
        restoreOptions: Parameters<typeof restorePendingWorkflowOnLiveServer>[0],
      ): Effect.Effect<boolean> => {
        const eff = restorePendingWorkflowOnLiveServer(restoreOptions)
        return restoreOptions.backup !== undefined
          ? withClusterDaemonLockIfGit(clusterRepoRoot, eff)
          : eff
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
                const restored = yield* runLockedLiveRestore({
                  clusterRepoRoot,
                  clusterRootDir,
                  baseUrl: targetBaseUrl,
                  backup: pendingBackup,
                  verifyEmptyBeforeRestore: true,
                  driftActionTag: "NoOp",
                })
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
              explicitEnvUrl !== undefined || serverMeta?.canonicalRepoRoot === canonicalRepoRoot
            if (!serverJsonCorruptOrUnreadable && belongsToThisRepo) {
              const probe = yield* probeOmnigraphServerReady(targetBaseUrl)
              const alreadyReady = match(probe)
                .with({ _tag: "Ready" }, () => true)
                .with({ _tag: "NotReady" }, () => false)
                .exhaustive()
              if (alreadyReady) {
                const restored = yield* runLockedLiveRestore({
                  clusterRepoRoot,
                  clusterRootDir,
                  baseUrl: targetBaseUrl,
                  backup: pendingBackup,
                  verifyEmptyBeforeRestore: true,
                  driftActionTag: "NoOp",
                })
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

      const executeLifecycle = Effect.gen(function* () {
        let spawnedPidToCleanup: number | undefined = undefined
        const cleanupSpawned = (reason: string): Effect.Effect<void> => {
          const pid = spawnedPidToCleanup
          spawnedPidToCleanup = undefined
          return cleanupSpawnedOmnigraphServer(pid, clusterRootDir, reason)
        }

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
                  typeof serverPid === "number" && Number.isInteger(serverPid) && serverPid > 1
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
                      : match(
                          writePendingWorkflowRestoreJournal(
                            clusterRepoRoot,
                            backedUp,
                            clusterRootDir,
                            preRebuildConfigStamp,
                            computeSha256Hex(drift.expectedStamp),
                          ),
                        )
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
                if (nodeSyncHostIo.existsSync(join(clusterRootDir, "graphs", "harness.omni"))) {
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
                  const stopped = stopStaleOmnigraphClusterBeforeDelete(clusterRootDir, undefined)
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

          const setupRes = yield* setupAndSpawnOmnigraphCluster({
            clusterRepoRoot,
            clusterRootDir,
            configDir,
            omnigraphBin,
            omnigraphServerBin,
            targetBaseUrl,
            defaultPort,
            hasPolicies,
            applyCluster: driftHandled.applyCluster,
          })

          const canFallbackProbe = match(drift.action)
            .with({ _tag: "RequiresCleanRebuild" }, () => false)
            .with({ _tag: "LiveClusterApply" }, { _tag: "NoOp" }, () => true)
            .exhaustive()

          const nonRebuildDriftTag = match(drift.action)
            .with({ _tag: "LiveClusterApply" }, () => "LiveClusterApply" as const)
            .with({ _tag: "NoOp" }, { _tag: "RequiresCleanRebuild" }, () => "NoOp" as const)
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
                  return yield* restorePendingWorkflowOnLiveServer({
                    clusterRepoRoot,
                    clusterRootDir,
                    baseUrl: targetBaseUrl,
                    backup: driftHandled.workflowBackup,
                    verifyEmptyBeforeRestore: true,
                    driftActionTag: nonRebuildDriftTag,
                  })
                }
                yield* Effect.sleep("100 millis")
              }
            }
            return false
          }

          spawnedPidToCleanup = setupRes.pid
          return yield* waitForSpawnedOmnigraphReady({
            clusterRepoRoot,
            clusterRootDir,
            canonicalRepoRoot,
            configDir,
            expectedStamp: drift.expectedStamp,
            targetBaseUrl,
            defaultPort,
            spawnedPid: setupRes.pid,
            appliedCluster: setupRes.appliedCluster,
            workflowBackup: driftHandled.workflowBackup,
            verifyEmptyBeforeRestore: canFallbackProbe,
            driftActionTag: nonRebuildDriftTag,
            onSuccessClearSpawnedPid: () => {
              spawnedPidToCleanup = undefined
            },
            cleanupSpawned,
          })
        })

        return yield* body.pipe(Effect.onInterrupt(() => cleanupSpawned("fiber interrupt")))
      })

      return yield* match(drift.action)
        .with({ _tag: "RequiresCleanRebuild" }, () =>
          withClusterDaemonLockIfGit(clusterRepoRoot, executeLifecycle),
        )
        .with({ _tag: "LiveClusterApply" }, { _tag: "NoOp" }, () =>
          pendingBackup !== undefined
            ? withClusterDaemonLockIfGit(clusterRepoRoot, executeLifecycle)
            : executeLifecycle,
        )
        .exhaustive()
    })

    return yield* withOmnigraphClusterStartupLock(clusterRootDir, lifecycleEffect, {
      timeoutMs: 45_000,
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          process.stderr.write(
            `[harness:omnigraph] Failed to acquire cluster startup lock for ${clusterRootDir}: ${err.reason}\n`,
          )
          return false
        }),
      ),
    )
  })
}
