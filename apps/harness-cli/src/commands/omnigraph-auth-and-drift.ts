import { createHash, randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  OmnigraphDiagnosticCode,
  type OmnigraphLintDiagnostic,
  type OmnigraphLintInput,
  type OmnigraphSchemaEvolutionAction,
  OmnigraphTargetName,
} from "@harness/contract"
import { decideOmnigraphLint, decideOmnigraphSchemaEvolution } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { isProcessPidAlive, isSafeOmnigraphPidToKill } from "./omnigraph-safety-helpers.js"

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

const OmnigraphLintFindingJsonSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.Literals(["error", "warning", "info"])),
  target: Schema.optional(Schema.NullOr(Schema.String)),
  target_name: Schema.optional(Schema.NullOr(Schema.String)),
  targetName: Schema.optional(Schema.NullOr(Schema.String)),
})

const OmnigraphLintJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.optional(Schema.String),
    errors: Schema.optional(Schema.Finite),
    warnings: Schema.optional(Schema.Finite),
    queries_processed: Schema.optional(Schema.Finite),
    findings: Schema.optional(Schema.Array(OmnigraphLintFindingJsonSchema)),
    diagnostics: Schema.optional(Schema.Array(OmnigraphLintFindingJsonSchema)),
  }),
)

const EndpointTokensSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  cliToken: Schema.NonEmptyString,
  mcpToken: Schema.NonEmptyString,
})

const EndpointTokensJsonSchema = Schema.fromJsonString(EndpointTokensSchema)

export type OmnigraphEndpointTokens = Schema.Schema.Type<typeof EndpointTokensSchema>

export type OfflineOmnigraphLintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export const resolveDefaultOmnigraphBin = (): string =>
  join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")

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
      return { ok: true } as const
    }
    const schemaPath = join(repoRoot, "libs", "harness", "graph", "schema.pg")
    const queryPath = join(repoRoot, "libs", "harness", "graph", "queries", "harness.gq")
    if (!nodeSyncHostIo.existsSync(schemaPath) || !nodeSyncHostIo.existsSync(queryPath)) {
      return { ok: true } as const
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
              ...(d.severity !== undefined ? { severity: d.severity } : {}),
            }
          })

          const lintInput: OmnigraphLintInput = {
            statusOk: parsed.status === "ok",
            errorCount: NonNegativeCount.make(Math.max(0, Math.floor(parsed.errors ?? 0))),
            warningCount: NonNegativeCount.make(Math.max(0, Math.floor(parsed.warnings ?? 0))),
            queriesProcessed: NonNegativeCount.make(
              Math.max(0, Math.floor(parsed.queries_processed ?? 0)),
            ),
            diagnostics,
            failOnError: true,
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
                  const summary = violations.map((v) => `[${v.ruleId}] ${v.message}`).join("; ")
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

    const action = yield* decideOmnigraphSchemaEvolution({
      clusterExists,
      queriesChanged,
      schemaAdditiveChanged,
      policyBundleOrEdgeKeyChanged,
      serverAlive,
    })

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
    createdAtMs: Schema.optional(Schema.Finite),
  }),
)

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
        cliToken: randomBytes(32).toString("hex"),
        mcpToken: randomBytes(32).toString("hex"),
      }
      return Result.map(writeSecureJsonAtomic(tokensPath, tokens), () => tokens)
    })
    .exhaustive()
}

export const acquireOmnigraphClusterLock = (clusterRootDir: string): string | undefined => {
  const lockParent = dirname(clusterRootDir)
  if (!nodeSyncHostIo.existsSync(lockParent)) {
    nodeSyncHostIo.mkdirRecursiveSync(lockParent)
  }
  const lockPath = `${clusterRootDir}.startup.lock`
  const payload = JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    const writeRes = nodeSyncHostIo.tryWriteExclusiveTextSync(lockPath, payload, 0o600)
    const acquired = match(writeRes)
      .with({ _tag: "Written" }, () => lockPath)
      .with({ _tag: "Exists" }, { _tag: "Failed" }, () => undefined)
      .exhaustive()
    if (acquired !== undefined) {
      return acquired
    }
    const staleCleared = Result.getOrElse(
      Result.try(() => {
        const mtimeMs = nodeSyncHostIo.statMtimeMsSync(lockPath) ?? 0
        const ageMs = Date.now() - mtimeMs
        const raw = nodeSyncHostIo.readTextSync(lockPath)
        const parsedOpt = Schema.decodeOption(StartupLockJsonSchema)(raw)
        const ownerAlive = match(parsedOpt)
          .with({ _tag: "Some" }, ({ value }) =>
            typeof value.pid === "number" && isProcessPidAlive(value.pid),
          )
          .with({ _tag: "None" }, () => false)
          .exhaustive()
        if (!ownerAlive || ageMs > 30_000) {
          nodeSyncHostIo.unlinkSync(lockPath)
          return true
        }
        return false
      }),
      () => false,
    )
    if (!staleCleared) {
      return undefined
    }
  }
  return undefined
}

export const releaseOmnigraphClusterLock = (lockPath: string | undefined): void => {
  if (lockPath === undefined) return
  Result.try(() => nodeSyncHostIo.unlinkSync(lockPath))
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

export const runOmnigraphOptimizeAndCleanup = (
  clusterRootDir: string,
  omnigraphBin: string = resolveDefaultOmnigraphBin(),
): void => {
  if (!nodeSyncHostIo.existsSync(omnigraphBin) || !nodeSyncHostIo.existsSync(clusterRootDir)) {
    return
  }
  const targetUri = `file://${clusterRootDir}`
  for (const args of [
    ["optimize", "--target", targetUri, "--graph", "harness", "--as", "harness-cli"],
    ["cleanup", "--target", targetUri, "--graph", "harness", "--as", "harness-cli", "--keep", "5"],
  ] as const) {
    const subcommand = args[0]
    const execAttempt = Result.try(() =>
      nodeSyncHostIo.execFileSync(omnigraphBin, [...args], {
        timeoutMs: 15_000,
      }),
    )
    match(execAttempt)
      .with({ _tag: "Failure" }, ({ failure }) => {
        process.stderr.write(
          `[harness:omnigraph] Warning: omnigraph ${subcommand} failed: ${failure instanceof Error ? failure.message : String(failure)}\n`,
        )
      })
      .with({ _tag: "Success" }, ({ success: res }) => {
        match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stderr, stdout }) => {
            if (exitCode !== 0) {
              process.stderr.write(
                `[harness:omnigraph] Warning: omnigraph ${subcommand} exited ${exitCode}: ${stderr || stdout}\n`,
              )
            }
          })
          .with({ _tag: "TimedOut" }, ({ stderr }) => {
            process.stderr.write(
              `[harness:omnigraph] Warning: omnigraph ${subcommand} timed out: ${stderr}\n`,
            )
          })
          .with({ _tag: "Signaled" }, ({ signal, stderr }) => {
            process.stderr.write(
              `[harness:omnigraph] Warning: omnigraph ${subcommand} killed by ${signal}: ${stderr}\n`,
            )
          })
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => {
            process.stderr.write(
              `[harness:omnigraph] Warning: omnigraph ${subcommand} spawn failed: ${spawnError}\n`,
            )
          })
          .exhaustive()
      })
      .exhaustive()
  }
}
