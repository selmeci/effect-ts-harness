import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"

export const CLI_REPO_ROOT = (() => {
  let curr = resolve(dirname(fileURLToPath(import.meta.url)))
  while (curr !== dirname(curr)) {
    if (nodeSyncHostIo.existsSync(join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = dirname(curr)
  }
  return process.cwd()
})()

export const findWorkspaceRoot = (startDir: string = process.cwd()): string => {
  let curr = resolve(startDir)
  while (curr !== dirname(curr)) {
    if (nodeSyncHostIo.existsSync(join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = dirname(curr)
  }
  return CLI_REPO_ROOT
}

export const resolveClusterRepoRoot = (repoRoot: string): string =>
  nodeSyncHostIo.existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
    ? repoRoot
    : findWorkspaceRoot(repoRoot)

const LockJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

function unlockOmnigraphClusterIfNeeded(
  omnigraphBin: string,
  clusterRootDir: string,
  applyOutput?: string,
): void {
  const lockIds = new Set<string>()
  if (applyOutput) {
    const lockMatch = applyOutput.match(/Admission lock:\s*([A-Za-z0-9_-]+)/)
    if (lockMatch?.[1]) {
      lockIds.add(lockMatch[1])
    }
  }
  const lockPath = join(clusterRootDir, "__cluster", "lock.json")
  if (nodeSyncHostIo.existsSync(lockPath)) {
    Result.getOrElse(
      Result.try(() => {
        const parsedOpt = Schema.decodeOption(LockJsonSchema)(
          nodeSyncHostIo.readTextSync(lockPath),
        )
        match(parsedOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            for (const key of ["lock_id", "id", "lockId", "holder_id"]) {
              const val = value[key]
              if (typeof val === "string" && val.length > 0) {
                lockIds.add(val)
              }
            }
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      }),
      () => undefined,
    )
  }
  for (const lockId of lockIds) {
    Result.getOrElse(
      Result.try(() => {
        nodeSyncHostIo.execFileSync(
          omnigraphBin,
          ["cluster", "force-unlock", lockId, "--target", clusterRootDir],
          { timeoutMs: 5_000 },
        )
      }),
      () => undefined,
    )
  }
}

function checkOmnigraphServerReady(baseUrl: string): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: () =>
      globalThis
        .fetch(`${baseUrl}/readyz`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        })
        .then((r) =>
          match(r.status)
            .with(200, () => {
              if (r.headers.get("Omnigraph-Http-Api") !== "0.14") {
                return Promise.resolve(false)
              }
              return r.json().then((rawBody: unknown) => {
                if (typeof rawBody !== "object" || rawBody === null) {
                  return false
                }
                const body = rawBody as {
                  readonly ready?: boolean
                  readonly status?: string
                  readonly ready_graph_count?: number
                }
                return (
                  (body.ready === true || body.status === "serving") &&
                  (body.ready_graph_count ?? 0) >= 1
                )
              })
            })
            .otherwise(() => Promise.resolve(false)),
        )
        .catch(() => false),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))
}

function computeOmnigraphConfigStamp(configDir: string): string {
  return ["cluster.yaml", "schema.pg", "queries/harness.gq"]
    .map((f) => {
      const p = join(configDir, f)
      return nodeSyncHostIo.existsSync(p) ? nodeSyncHostIo.readTextSync(p) : ""
    })
    .join("\n---\n")
}

export const buildOmnigraphClusterKillArgs = (
  clusterRootDir: string,
): readonly [string, ReadonlyArray<string>] => {
  const escaped = clusterRootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return ["pkill", ["-f", `omnigraph-server.*--cluster file://${escaped}`]]
}

const OmnigraphServerMetaSchema = Schema.Struct({
  pid: Schema.optional(Schema.Finite),
  port: Schema.optional(Schema.Finite),
  baseUrl: Schema.optional(Schema.String),
  canonicalRepoRoot: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
})

type OmnigraphServerMeta = Schema.Schema.Type<typeof OmnigraphServerMetaSchema>

const decodeOmnigraphServerMeta = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema),
)

export function ensureLocalOmnigraphReady(repoRoot: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const clusterRepoRoot = resolveClusterRepoRoot(repoRoot)
    const canonicalRepoRoot = resolveCanonicalRepoRoot(clusterRepoRoot, nodeSyncHostIo)
    const clusterRootDir = resolveOmnigraphClusterDir(clusterRepoRoot, nodeSyncHostIo)
    const defaultPort = deriveRepoOmnigraphPort(canonicalRepoRoot, nodeSyncHostIo)

    let serverMeta: OmnigraphServerMeta | undefined
    const serverJsonPath = join(clusterRootDir, "server.json")
    if (nodeSyncHostIo.existsSync(serverJsonPath)) {
      const decodedMetaOpt = yield* Effect.try({
        try: () => nodeSyncHostIo.readTextSync(serverJsonPath),
        catch: () => "",
      }).pipe(
        Effect.flatMap((raw) => Effect.fromOption(decodeOmnigraphServerMeta(raw))),
        Effect.option,
      )
      serverMeta = match(decodedMetaOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
    }

    const explicitEnvUrl =
      process.env.OMNIGRAPH_URL && process.env.OMNIGRAPH_URL !== "http://127.0.0.1:8080"
        ? process.env.OMNIGRAPH_URL
        : undefined
    const targetBaseUrl =
      explicitEnvUrl ??
      (serverMeta?.canonicalRepoRoot === canonicalRepoRoot && serverMeta?.baseUrl
        ? serverMeta.baseUrl
        : `http://127.0.0.1:${defaultPort}`)

    const configDir = join(clusterRepoRoot, "libs", "harness", "graph")
    const stampPath = join(clusterRootDir, ".config-stamp")
    const expectedStamp = computeOmnigraphConfigStamp(configDir)
    const currentStamp = nodeSyncHostIo.existsSync(stampPath)
      ? nodeSyncHostIo.readTextSync(stampPath)
      : ""
    const configDrifted = currentStamp !== expectedStamp

    if (configDrifted) {
      const serverPid = serverMeta?.pid
      if (typeof serverPid === "number") {
        yield* Effect.try({
          try: () => {
            process.kill(serverPid, "SIGTERM")
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
      }
      yield* Effect.try({
        try: () => {
          const [killBin, killArgs] = buildOmnigraphClusterKillArgs(clusterRootDir)
          nodeSyncHostIo.execFileSync(killBin, [...killArgs], { timeoutMs: 5_000 })
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
      yield* Effect.sleep("300 millis")
      yield* Effect.try({
        try: () => {
          nodeSyncHostIo.rmRecursiveSync(clusterRootDir)
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    } else {
      const belongsToThisRepo =
        explicitEnvUrl !== undefined || serverMeta?.canonicalRepoRoot === canonicalRepoRoot
      if (belongsToThisRepo) {
        const alreadyReady = yield* checkOmnigraphServerReady(targetBaseUrl)
        if (alreadyReady) {
          return true
        }
      }
    }

    const homeBin = join(process.env.HOME ?? "/root", ".local", "bin")
    const omnigraphBin = join(homeBin, "omnigraph")
    const omnigraphServerBin = join(homeBin, "omnigraph-server")

    if (!nodeSyncHostIo.existsSync(omnigraphBin) || !nodeSyncHostIo.existsSync(omnigraphServerBin)) {
      yield* Effect.try({
        try: () => {
          nodeSyncHostIo.execFileSync(
            "bash",
            [
              "-c",
              "curl -fsSL https://raw.githubusercontent.com/ModernRelay/omnigraph/main/scripts/install.sh | VERSION=v0.14.0 bash",
            ],
            { timeoutMs: 60_000 },
          )
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    }

    if (!nodeSyncHostIo.existsSync(omnigraphBin) || !nodeSyncHostIo.existsSync(omnigraphServerBin)) {
      return false
    }

    let spawnSucceeded = false
    yield* Effect.try({
      try: () => {
        if (!nodeSyncHostIo.existsSync(clusterRootDir)) {
          nodeSyncHostIo.mkdirRecursiveSync(clusterRootDir)
        }
        unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)

        const graphOmniDir = join(clusterRootDir, "graphs", "harness.omni")
        if (!nodeSyncHostIo.existsSync(graphOmniDir)) {
          const outRes = nodeSyncHostIo.execFileSync(
            omnigraphBin,
            [
              "cluster",
              "apply",
              "--target",
              clusterRootDir,
              "--config",
              configDir,
              "--as",
              "harness-cli",
              "--json",
            ],
            {
              cwd: clusterRepoRoot,
              timeoutMs: 30_000,
            },
          )
          if (outRes.exitCode !== 0) {
            process.stderr.write(
              `[harness:omnigraph] Local omnigraph cluster apply failed: ${outRes.stderr || outRes.stdout || "unknown error"}\n`,
            )
            return
          }
          unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir, outRes.stdout)
          nodeSyncHostIo.writeTextSync(stampPath, expectedStamp)
        }
        unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)

        const bindHostPort =
          targetBaseUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? `127.0.0.1:${defaultPort}`
        nodeSyncHostIo.spawnDetached(
          omnigraphServerBin,
          ["--cluster", `file://${clusterRootDir}`, "--bind", bindHostPort, "--unauthenticated"],
          { cwd: clusterRepoRoot },
        )
        spawnSucceeded = true

        nodeSyncHostIo.writeTextSync(
          join(clusterRootDir, "server.json"),
          JSON.stringify(
            {
              port: defaultPort,
              baseUrl: targetBaseUrl,
              canonicalRepoRoot,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        )
      },
      catch: (err) => {
        process.stderr.write(
          `[harness:omnigraph] Local omnigraph setup/spawn failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return undefined
      },
    }).pipe(Effect.orElseSucceed(() => undefined))

    // When spawn succeeded, poll /readyz for up to 3 seconds while omnigraph-server binds and loads.
    // When setup/spawn failed, probe /readyz at most once to fail fast with the logged cause
    // (while still allowing an externally managed server that just came up to answer).
    if (!spawnSucceeded) {
      return yield* checkOmnigraphServerReady(targetBaseUrl)
    }
    for (let i = 0; i < 30; i++) {
      if (yield* checkOmnigraphServerReady(targetBaseUrl)) {
        return true
      }
      yield* Effect.sleep("100 millis")
    }
    return false
  })
}
