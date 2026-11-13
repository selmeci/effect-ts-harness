import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Option, Schema } from "effect"
import {
  deriveRepoOmnigraphPort,
  resolveCanonicalRepoRoot,
  resolveOmnigraphClusterDir,
} from "@harness/gates"

export const CLI_REPO_ROOT = (() => {
  let curr = resolve(dirname(fileURLToPath(import.meta.url)))
  while (curr !== dirname(curr)) {
    if (existsSync(join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = dirname(curr)
  }
  return process.cwd()
})()

export const findWorkspaceRoot = (startDir: string = process.cwd()): string => {
  let curr = resolve(startDir)
  while (curr !== dirname(curr)) {
    if (existsSync(join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = dirname(curr)
  }
  return CLI_REPO_ROOT
}

export const resolveClusterRepoRoot = (repoRoot: string): string =>
  existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
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
  if (existsSync(lockPath)) {
    Effect.runSync(
      Effect.try({
        try: () => {
          const parsedOpt = Schema.decodeOption(LockJsonSchema)(readFileSync(lockPath, "utf-8"))
          if (Option.isSome(parsedOpt)) {
            for (const key of ["lock_id", "id", "lockId", "holder_id"]) {
              const val = parsedOpt.value[key]
              if (typeof val === "string" && val.length > 0) {
                lockIds.add(val)
              }
            }
          }
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
    )
  }
  for (const lockId of lockIds) {
    Effect.runSync(
      Effect.try({
        try: () => {
          execFileSync(
            omnigraphBin,
            ["cluster", "force-unlock", lockId, "--target", clusterRootDir],
            { stdio: "ignore", timeout: 5_000 },
          )
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
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
        .then((r) => {
          if (r.status !== 200 || r.headers.get("Omnigraph-Http-Api") !== "0.14") {
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
        .catch(() => false),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))
}

function computeOmnigraphConfigStamp(configDir: string): string {
  return ["cluster.yaml", "schema.pg", "queries/harness.gq"]
    .map((f) => {
      const p = join(configDir, f)
      return existsSync(p) ? readFileSync(p, "utf-8") : ""
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
    const canonicalRepoRoot = resolveCanonicalRepoRoot(clusterRepoRoot)
    const clusterRootDir = resolveOmnigraphClusterDir(clusterRepoRoot)
    const defaultPort = deriveRepoOmnigraphPort(canonicalRepoRoot)

    let serverMeta: OmnigraphServerMeta | undefined
    const serverJsonPath = join(clusterRootDir, "server.json")
    if (existsSync(serverJsonPath)) {
      const decodedMetaOpt = yield* Effect.try({
        try: () => readFileSync(serverJsonPath, "utf-8"),
        catch: () => "",
      }).pipe(
        Effect.flatMap((raw) => Effect.fromOption(decodeOmnigraphServerMeta(raw))),
        Effect.option,
      )
      if (Option.isSome(decodedMetaOpt)) {
        serverMeta = decodedMetaOpt.value
      }
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
    const currentStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf-8") : ""
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
          execFileSync(killBin, [...killArgs], { stdio: "ignore", timeout: 5_000 })
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
      yield* Effect.sleep("300 millis")
      yield* Effect.try({
        try: () => {
          rmSync(clusterRootDir, { recursive: true, force: true })
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    } else if (explicitEnvUrl !== undefined || serverMeta?.canonicalRepoRoot === canonicalRepoRoot) {
      const alreadyReady = yield* checkOmnigraphServerReady(targetBaseUrl)
      if (alreadyReady) {
        return true
      }
    }

    const homeBin = join(process.env.HOME ?? "/root", ".local", "bin")
    const omnigraphBin = join(homeBin, "omnigraph")
    const omnigraphServerBin = join(homeBin, "omnigraph-server")

    if (!existsSync(omnigraphBin) || !existsSync(omnigraphServerBin)) {
      yield* Effect.try({
        try: () => {
          execFileSync(
            "bash",
            [
              "-c",
              "curl -fsSL https://raw.githubusercontent.com/ModernRelay/omnigraph/main/scripts/install.sh | VERSION=v0.14.0 bash",
            ],
            { stdio: "inherit", timeout: 60_000 },
          )
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    }

    if (!existsSync(omnigraphBin) || !existsSync(omnigraphServerBin)) {
      return false
    }

    let spawnInitiated = false
    yield* Effect.try({
      try: () => {
        if (!existsSync(clusterRootDir)) {
          mkdirSync(clusterRootDir, { recursive: true })
        }
        unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)

        const graphOmniDir = join(clusterRootDir, "graphs", "harness.omni")
        if (!existsSync(graphOmniDir)) {
          const out = execFileSync(
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
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 30_000,
            },
          )
          unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir, out)
          writeFileSync(stampPath, expectedStamp, "utf-8")
        }
        unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)

        const bindHostPort =
          targetBaseUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? `127.0.0.1:${defaultPort}`
        const child = spawn(
          omnigraphServerBin,
          ["--cluster", `file://${clusterRootDir}`, "--bind", bindHostPort, "--unauthenticated"],
          { cwd: clusterRepoRoot, detached: true, stdio: "ignore" },
        )
        child.unref()

        if (child.pid !== undefined) {
          spawnInitiated = true
          writeFileSync(
            join(clusterRootDir, "server.json"),
            JSON.stringify(
              {
                pid: child.pid,
                port: defaultPort,
                baseUrl: targetBaseUrl,
                canonicalRepoRoot,
                updatedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
            "utf-8",
          )
        }
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))

    if (!spawnInitiated) {
      return false
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
