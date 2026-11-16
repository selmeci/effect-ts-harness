import { createHash, randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  OmnigraphActorToken,
  type OmnigraphAuthTokens,
  OmnigraphAuthTokensSchema,
  type OmnigraphConfigDriftKind,
  OmnigraphDiagnosticCode,
  type OmnigraphLintDiagnostic,
  type OmnigraphLintInput,
  OmnigraphLintStatus,
  type OmnigraphSchemaEvolutionAction,
  OmnigraphTargetName,
} from "@harness/contract"
import { decideOmnigraphLint, decideOmnigraphSchemaEvolution } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import {
  isProcessPidAlive,
  isSafeOmnigraphPidToKill,
  resolveDefaultOmnigraphBin,
  runOmnigraphOptimizeAndCleanup,
} from "./omnigraph-safety-helpers.js"

export { resolveDefaultOmnigraphBin, runOmnigraphOptimizeAndCleanup }

export const CLUSTER_SCHEMA_EPOCH = "rfc-0009-v2"

const CONFIG_DIGEST_FILES = [
  "cluster.yaml",
  "schema.pg",
  "queries/harness.gq",
  "graph.policy.yaml",
  "cluster.policy.yaml",
] as const

const ConfigDigestsSchema = Schema.fromJsonString(
  Schema.Struct({
    "cluster.yaml": Schema.String,
    "schema.pg": Schema.String,
    "schema.pg@keys": Schema.optional(Schema.String),
    "queries/harness.gq": Schema.String,
    "graph.policy.yaml": Schema.String,
    "cluster.policy.yaml": Schema.String,
  }),
)

type ConfigDigests = Schema.Schema.Type<typeof ConfigDigestsSchema>

const RawOmnigraphLintDiagnosticSchema = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  targetName: Schema.optional(Schema.NullOr(Schema.String)),
  target_name: Schema.optional(Schema.NullOr(Schema.String)),
  target: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.optional(Schema.Literals(["error", "warning", "info"])),
})

const OmnigraphLintJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.optional(Schema.NullOr(Schema.String)),
    queries_processed: Schema.optional(Schema.NullOr(Schema.Finite)),
    findings: Schema.optional(Schema.NullOr(Schema.Array(RawOmnigraphLintDiagnosticSchema))),
    diagnostics: Schema.optional(Schema.NullOr(Schema.Array(RawOmnigraphLintDiagnosticSchema))),
  }),
)

const EndpointTokensJsonSchema = Schema.fromJsonString(OmnigraphAuthTokensSchema)

export type OmnigraphEndpointTokens = OmnigraphAuthTokens

export type OfflineOmnigraphLintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export const resolveOmnigraphConfigDir = (repoRoot: string, clusterRepoRoot: string): string => {
  const worktreeConfigDir = join(repoRoot, "libs", "harness", "graph")
  return nodeSyncHostIo.existsSync(join(worktreeConfigDir, "cluster.yaml"))
    ? worktreeConfigDir
    : join(clusterRepoRoot, "libs", "harness", "graph")
}

export const runOfflineOmnigraphLintGate = (
  repoRoot: string,
  omnigraphBin: string = resolveDefaultOmnigraphBin(),
): Effect.Effect<OfflineOmnigraphLintResult> =>
  Effect.gen(function* () {
    if (!nodeSyncHostIo.existsSync(omnigraphBin)) {
      return {
        ok: false as const,
        message: `omnigraph binary not found at ${omnigraphBin}; cannot run offline lint gate`,
      }
    }
    const schemaPath = join(repoRoot, "libs", "harness", "graph", "schema.pg")
    const queryPath = join(repoRoot, "libs", "harness", "graph", "queries", "harness.gq")
    if (!nodeSyncHostIo.existsSync(schemaPath) || !nodeSyncHostIo.existsSync(queryPath)) {
      return {
        ok: false as const,
        message: `Missing Omnigraph schema (${schemaPath}) or query (${queryPath}) file; cannot run offline lint gate`,
      }
    }

    const execAttempt = Result.try(() =>
      nodeSyncHostIo.execFileSync(
        omnigraphBin,
        ["lint", "--schema", schemaPath, "--query", queryPath, "--json"],
        { cwd: repoRoot, timeoutMs: 15_000 },
      ),
    )

    const execOutcome = match(execAttempt)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        _tag: "ExecError" as const,
        message: `omnigraph lint execution failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      }))
      .with({ _tag: "Success" }, ({ success: res }) =>
        match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => ({
            _tag: "Exited" as const,
            exitCode,
            stdout,
            stderr,
          }))
          .with({ _tag: "TimedOut" }, ({ stderr }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint timed out: ${stderr}`,
          }))
          .with({ _tag: "Signaled" }, ({ signal, stderr }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint killed by ${signal}: ${stderr}`,
          }))
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint spawn failed: ${spawnError}`,
          }))
          .exhaustive(),
      )
      .exhaustive()

    return yield* match(execOutcome)
      .with({ _tag: "ExecError" }, ({ message }) =>
        Effect.succeed({ ok: false as const, message }),
      )
      .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
        Effect.gen(function* () {
          const parsedOpt = Schema.decodeOption(OmnigraphLintJsonSchema)(stdout)
          const parsed = match(parsedOpt)
            .with({ _tag: "Some" }, ({ value }) => value)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()

          if (parsed === undefined) {
            const detail = stderr.trim() || stdout.trim() || `exitCode=${exitCode}`
            return {
              ok: false as const,
              message: `omnigraph lint returned invalid JSON (${detail})`,
            }
          }

          const rawDiagnostics = parsed.findings ?? parsed.diagnostics ?? []
          const diagnostics: Array<OmnigraphLintDiagnostic> = rawDiagnostics.map((d) => {
            const rawCode = (d.code ?? "LINT_ERROR").trim() || "LINT_ERROR"
            const rawMsg = (d.message ?? "Omnigraph lint diagnostic").trim() || "Omnigraph lint diagnostic"
            const rawTarget = (d.targetName ?? d.target_name ?? d.target ?? null)?.trim() ?? null
            return {
              code: OmnigraphDiagnosticCode.make(rawCode),
              message: ErrorReasonMessage.make(rawMsg),
              targetName: rawTarget && rawTarget.length > 0 ? OmnigraphTargetName.make(rawTarget) : null,
              severity: d.severity ?? "error",
            }
          })

          const statusOk = match(
            Schema.decodeUnknownOption(OmnigraphLintStatus)(parsed.status?.trim()),
          )
            .with({ _tag: "Some" }, ({ value }) =>
              match(value)
                .with("ok", () => true)
                .with("error", () => false)
                .exhaustive(),
            )
            .with({ _tag: "None" }, () => false)
            .exhaustive()

          const lintInput: OmnigraphLintInput = {
            statusOk,
            queriesProcessed: NonNegativeCount.make(
              Math.max(0, Math.floor(parsed.queries_processed ?? 0)),
            ),
            diagnostics,
            policy: "fail-on-error",
          }

          const lintRes = yield* decideOmnigraphLint(lintInput).pipe(
            Effect.map((report) => ({ _tag: "Report" as const, report })),
            Effect.catchTag("OmnigraphLintError", (err) => Effect.succeed({ _tag: "Err" as const, err })),
          )

          return match(lintRes)
            .with({ _tag: "Err" }, ({ err }) => ({
              ok: false as const,
              message: `omnigraph lint failed (${err.errorCount} errors): ${err.diagnosticsSummary}`,
            }))
            .with({ _tag: "Report" }, ({ report }) =>
              match(report)
                .with({ verdict: "violated" }, ({ violations }) => {
                  const summary = violations.map((v) => `[${v._tag}] ${v.message}`).join("; ")
                  return { ok: false as const, message: `omnigraph lint failed: ${summary}` }
                })
                .with({ verdict: "clean" }, () => {
                  if (exitCode !== 0) {
                    const detail = stderr.trim() || `exitCode=${exitCode}`
                    return { ok: false as const, message: `omnigraph lint exited with ${detail}` }
                  }
                  return { ok: true as const }
                })
                .exhaustive(),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  })

export const computeOmnigraphConfigStamp = (configDir: string): string => {
  const baseFiles = ["cluster.yaml", "schema.pg", "queries/harness.gq"]
  const optionalPolicyFiles = ["graph.policy.yaml", "cluster.policy.yaml"].filter((f) =>
    nodeSyncHostIo.existsSync(join(configDir, f)),
  )
  return [...baseFiles, ...optionalPolicyFiles]
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

export const computeConfigDigests = (configDir: string): ConfigDigests => {
  const readFileOrEmpty = (relPath: string): string => {
    const fullPath = join(configDir, relPath)
    return nodeSyncHostIo.existsSync(fullPath) ? nodeSyncHostIo.readTextSync(fullPath) : ""
  }
  const hashContent = (content: string): string =>
    createHash("sha256").update(content).digest("hex")
  const schemaContent = readFileOrEmpty(CONFIG_DIGEST_FILES[1])
  return {
    "cluster.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[0])),
    "schema.pg": hashContent(schemaContent),
    "schema.pg@keys": extractSchemaEdgeKeyDigest(schemaContent),
    "queries/harness.gq": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[2])),
    "graph.policy.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[3])),
    "cluster.policy.yaml": hashContent(readFileOrEmpty(CONFIG_DIGEST_FILES[4])),
  }
}

export interface ClusterConfigDriftEvaluation {
  readonly action: OmnigraphSchemaEvolutionAction
  readonly expectedStamp: string
  readonly digests: ConfigDigests
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
        ? digests["queries/harness.gq"] !== prevDigests["queries/harness.gq"]
        : stampChanged
    const schemaAdditiveChanged =
      prevDigests !== undefined ? digests["schema.pg"] !== prevDigests["schema.pg"] : stampChanged
    const policyBundleOrEdgeKeyChanged =
      (clusterExists && !epochMatches && stampChanged) ||
      (prevDigests !== undefined
        ? digests["cluster.yaml"] !== prevDigests["cluster.yaml"] ||
          digests["graph.policy.yaml"] !== prevDigests["graph.policy.yaml"] ||
          digests["cluster.policy.yaml"] !== prevDigests["cluster.policy.yaml"] ||
          (prevDigests["schema.pg@keys"] !== undefined &&
            digests["schema.pg@keys"] !== prevDigests["schema.pg@keys"])
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

    return { action, expectedStamp, digests }
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

const StartupLockJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.optional(Schema.Finite),
    lockToken: Schema.optional(Schema.String),
    createdAtMs: Schema.optional(Schema.Finite),
  }),
)

export interface OmnigraphClusterLockHandle {
  readonly lockPath: string
  readonly lockToken: string
}

const ensureSecureClusterDir = (clusterRootDir: string): void => {
  if (!nodeSyncHostIo.existsSync(clusterRootDir)) {
    nodeSyncHostIo.mkdirRecursiveSync(clusterRootDir)
  }
  nodeSyncHostIo.chmodSync(clusterRootDir, 0o700)
}

const writeSecureJsonAtomic = (
  targetPath: string,
  payload: unknown,
): Result.Result<void, Error> => {
  const dir = dirname(targetPath)
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  return Result.try({
    try: () => {
      ensureSecureClusterDir(dir)
      nodeSyncHostIo.writeTextWithModeSync(tmpPath, JSON.stringify(payload, null, 2), 0o600)
      nodeSyncHostIo.chmodSync(tmpPath, 0o600)
      nodeSyncHostIo.renameSync(tmpPath, targetPath)
    },
    catch: (failure) => {
      Result.try(() => nodeSyncHostIo.unlinkSync(tmpPath))
      return failure instanceof Error ? failure : new Error(String(failure))
    },
  })
}

export const writeServerMetaAtomic = (
  clusterRootDir: string,
  meta: Record<string, unknown>,
): Result.Result<void, Error> => writeSecureJsonAtomic(join(clusterRootDir, "server.json"), meta)

export const ensureOmnigraphEndpointTokens = (
  clusterRootDir: string,
): Result.Result<OmnigraphEndpointTokens, Error> => {
  const dirRes = Result.try({
    try: () => ensureSecureClusterDir(clusterRootDir),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  })
  return match(dirRes)
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, () => {
      const tokensPath = join(clusterRootDir, "auth-tokens.json")
      if (nodeSyncHostIo.existsSync(tokensPath)) {
        const mode = nodeSyncHostIo.statModeSync(tokensPath)
        if (mode !== undefined && (mode & 0o077) !== 0) {
          return Result.fail(
            new Error(
              `Refusing to use auth-tokens.json with permissive mode ${mode.toString(8)}: ${tokensPath}`,
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

const RAW_LOCK_DECODE_GRACE_MS = 2_000

export type OmnigraphClusterLockAttemptResult =
  | { readonly _tag: "Acquired"; readonly handle: OmnigraphClusterLockHandle }
  | { readonly _tag: "Contended" }
  | { readonly _tag: "Failed"; readonly reason: string }

const compareAndUnlinkStaleLock = (lockPath: string, expectedRaw: string): boolean =>
  Result.getOrElse(
    Result.try(() => {
      if (nodeSyncHostIo.readTextSync(lockPath) !== expectedRaw) return false
      nodeSyncHostIo.unlinkSync(lockPath)
      return true
    }),
    () => false,
  )

export const tryAcquireOmnigraphClusterLock = (
  clusterRootDir: string,
): OmnigraphClusterLockAttemptResult => {
  const lockParent = dirname(clusterRootDir)
  const mkdirErr = match(
    Result.try({
      try: () => {
        if (!nodeSyncHostIo.existsSync(lockParent)) nodeSyncHostIo.mkdirRecursiveSync(lockParent)
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }),
  )
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
  if (mkdirErr !== undefined) {
    return { _tag: "Failed", reason: mkdirErr }
  }
  const lockPath = `${clusterRootDir}.startup.lock`
  const lockToken = randomBytes(16).toString("hex")
  const payload = JSON.stringify({ pid: process.pid, lockToken, createdAtMs: Date.now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    const writeStep = match(nodeSyncHostIo.tryWriteExclusiveTextSync(lockPath, payload, 0o600))
      .with({ _tag: "Written" }, () => ({
        done: true as const,
        result: { _tag: "Acquired" as const, handle: { lockPath, lockToken } },
      }))
      .with({ _tag: "Failed" }, ({ message }) => ({
        done: true as const,
        result: { _tag: "Failed" as const, reason: message },
      }))
      .with({ _tag: "Exists" }, () => ({ done: false as const, result: undefined }))
      .exhaustive()
    if (writeStep.done) {
      return writeStep.result
    }
    const readOutcome = match(Result.try(() => nodeSyncHostIo.readTextSync(lockPath)))
      .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, raw: success }))
      .with({ _tag: "Failure" }, () => ({ ok: false as const, raw: "" }))
      .exhaustive()
    if (!readOutcome.ok) {
      if (!nodeSyncHostIo.existsSync(lockPath)) continue
      return { _tag: "Contended" }
    }
    const raw = readOutcome.raw
    const parsedOpt = Schema.decodeOption(StartupLockJsonSchema)(raw)
    const canUnlinkStale = match(parsedOpt)
      .with({ _tag: "Some" }, ({ value }) => !(typeof value.pid === "number" && isProcessPidAlive(value.pid)))
      .with({ _tag: "None" }, () => {
        const mtimeMs = nodeSyncHostIo.statMtimeMsSync(lockPath)
        return mtimeMs !== undefined && Date.now() - mtimeMs >= RAW_LOCK_DECODE_GRACE_MS
      })
      .exhaustive()
    if (!canUnlinkStale || !compareAndUnlinkStaleLock(lockPath, raw)) {
      return { _tag: "Contended" }
    }
  }
  return { _tag: "Contended" }
}

export const acquireOmnigraphClusterLock = (
  clusterRootDir: string,
): OmnigraphClusterLockHandle | undefined =>
  match(tryAcquireOmnigraphClusterLock(clusterRootDir))
    .with({ _tag: "Acquired" }, ({ handle }) => handle)
    .with({ _tag: "Contended" }, { _tag: "Failed" }, () => undefined)
    .exhaustive()

export const acquireOmnigraphClusterLockEffect = (
  clusterRootDir: string,
  timeoutMs = 45_000,
): Effect.Effect<OmnigraphClusterLockHandle | undefined> =>
  Effect.gen(function* () {
    const deadlineMs = Date.now() + Math.max(0, timeoutMs)
    while (true) {
      const attempt = tryAcquireOmnigraphClusterLock(clusterRootDir)
      const resolved = match(attempt)
        .with({ _tag: "Acquired" }, ({ handle }) => ({ done: true as const, handle }))
        .with({ _tag: "Failed" }, ({ reason }) => {
          process.stderr.write(`[harness:omnigraph] Error: startup lock failed for ${clusterRootDir}: ${reason}\n`)
          return { done: true as const, handle: undefined }
        })
        .with({ _tag: "Contended" }, () => ({ done: false as const, handle: undefined }))
        .exhaustive()
      if (resolved.done) {
        return resolved.handle
      }
      if (Date.now() >= deadlineMs) {
        return undefined
      }
      yield* Effect.sleep("100 millis")
    }
  })

export const releaseOmnigraphClusterLock = (
  handle: OmnigraphClusterLockHandle | string | undefined,
): void => {
  if (handle === undefined) return
  if (typeof handle === "string") {
    Result.try(() => nodeSyncHostIo.unlinkSync(handle))
    return
  }
  Result.try(() => {
    if (!nodeSyncHostIo.existsSync(handle.lockPath)) return
    const raw = nodeSyncHostIo.readTextSync(handle.lockPath)
    const parsedOpt = Schema.decodeOption(StartupLockJsonSchema)(raw)
    const isOwner = match(parsedOpt)
      .with({ _tag: "Some" }, ({ value }) =>
        value.pid === process.pid && value.lockToken === handle.lockToken,
      )
      .with({ _tag: "None" }, () => false)
      .exhaustive()
    if (isOwner) {
      nodeSyncHostIo.unlinkSync(handle.lockPath)
    }
  })
}

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
    const killTermRes = yield* Effect.try({
      try: () => {
        process.kill(serverPid, "SIGTERM")
        return { ok: true as const }
      },
      catch: (err) => {
        const code =
          typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
            ? err.code
            : undefined
        if (code === "ESRCH") {
          return { ok: true as const }
        }
        process.stderr.write(
          `[harness:omnigraph] Error: failed to SIGTERM omnigraph PID ${serverPid}: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return { ok: false as const }
      },
    }).pipe(Effect.orElseSucceed(() => ({ ok: false as const })))
    if (!killTermRes.ok) {
      return false
    }
    for (let attempt = 0; attempt < 10 && isProcessPidAlive(serverPid); attempt++) {
      yield* Effect.sleep("50 millis")
    }
    if (isProcessPidAlive(serverPid)) {
      process.stderr.write(
        `[harness:omnigraph] Error: omnigraph PID ${serverPid} is still alive after SIGTERM during ${phaseLabel}\n`,
      )
      return false
    }
    return true
  })
