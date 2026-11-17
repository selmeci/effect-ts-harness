import { basename, join, resolve } from "node:path"
import { Effect, Graph, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  OmnigraphBranchName,
  OmnigraphEntityId,
  OmnigraphSpanName,
  OmnigraphTypeName,
} from "@harness/contract"
import { type HarnessGraph, type makeOmnigraphSyncLayer, OmnigraphSync } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"

const LOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const isValidLockId = (value: string): boolean => LOCK_ID_PATTERN.test(value)

export const isLoopbackOmnigraphUrl = (rawUrl: string): boolean =>
  Result.getOrElse(
    Result.try(() => {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false
      }
      if (parsed.username !== "" || parsed.password !== "") {
        return false
      }
      return (
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]"
      )
    }),
    () => false,
  )

const isOmnigraphExecutableBasename = (execToken: string): boolean => {
  const base = basename(execToken)
  return base === "omnigraph" || base === "omnigraph-server"
}

const isJsRuntimeBasename = (execToken: string): boolean => {
  const base = basename(execToken)
  return base === "node" || base === "tsx" || base === "bun"
}

const extractClusterFlagValue = (tokens: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === "--cluster") {
      const next = tokens[i + 1]
      return next !== undefined && next.length > 0 ? next : undefined
    }
    if (tok !== undefined && tok.startsWith("--cluster=")) {
      const val = tok.slice("--cluster=".length)
      return val.length > 0 ? val : undefined
    }
  }
  return undefined
}

const hasMatchingOmnigraphBinary = (tokens: ReadonlyArray<string>): boolean => {
  const first = tokens[0]
  if (first === undefined) {
    return false
  }
  if (isOmnigraphExecutableBasename(first)) {
    return true
  }
  if (isJsRuntimeBasename(first)) {
    return tokens
      .slice(1)
      .some((tok) => !tok.startsWith("-") && isOmnigraphExecutableBasename(tok))
  }
  return false
}

const parsePsCommandLine = (line: string): ReadonlyArray<string> => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return []
  const tokens: Array<string> = []
  let idx = 0
  while (idx < trimmed.length) {
    while (idx < trimmed.length && /\s/.test(trimmed[idx]!)) idx++
    if (idx >= trimmed.length) break
    const rest = trimmed.slice(idx)
    if (rest.startsWith("--cluster=")) {
      const nextFlagIdx = rest.slice("--cluster=".length).search(/\s--/)
      if (nextFlagIdx >= 0) {
        const end = "--cluster=".length + nextFlagIdx
        tokens.push(rest.slice(0, end))
        idx += end
      } else {
        tokens.push(rest)
        break
      }
      continue
    }
    if (rest.startsWith("--cluster ") || rest.startsWith("--cluster\t")) {
      tokens.push("--cluster")
      idx += "--cluster".length
      while (idx < trimmed.length && /\s/.test(trimmed[idx]!)) idx++
      const valRest = trimmed.slice(idx)
      const nextFlagIdx = valRest.search(/\s--/)
      if (nextFlagIdx >= 0) {
        tokens.push(valRest.slice(0, nextFlagIdx))
        idx += nextFlagIdx
        continue
      }
      if (valRest.length > 0) {
        tokens.push(valRest)
        break
      }
      continue
    }
    let end = idx
    while (end < trimmed.length && !/\s/.test(trimmed[end]!)) end++
    tokens.push(trimmed.slice(idx, end))
    idx = end
  }
  return tokens
}

const readProcessArgvTokens = (pid: number, hostIo: SyncHostIo): ReadonlyArray<string> => {
  const procCmdlinePath = `/proc/${pid}/cmdline`
  if (hostIo.existsSync(procCmdlinePath)) {
    const raw = Result.getOrElse(
      Result.try(() => hostIo.readTextSync(procCmdlinePath)),
      () => "",
    )
    return raw.split("\0").filter((t) => t.length > 0)
  }
  const psRes = Result.getOrElse(
    Result.try(() =>
      hostIo.execFileSync("ps", ["-p", String(pid), "-o", "args="], { timeoutMs: 2_000 }),
    ),
    () => undefined,
  )
  if (psRes === undefined) {
    return []
  }
  return match(psRes)
    .with({ _tag: "Exited" }, ({ exitCode, stdout }) =>
      exitCode === 0 ? parsePsCommandLine(stdout) : [],
    )
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => [])
    .exhaustive()
}

export const isSafeOmnigraphPidToKill = (
  pid: unknown,
  expectedClusterDir?: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): pid is number => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return false
  }
  const tokens = readProcessArgvTokens(pid, hostIo)
  if (!hasMatchingOmnigraphBinary(tokens)) {
    return false
  }
  const clusterValue = extractClusterFlagValue(tokens)
  if (clusterValue === undefined) {
    return false
  }
  if (expectedClusterDir !== undefined) {
    const actualPath = resolve(clusterValue.replace(/^file:\/\//, ""))
    const expectedPath = resolve(expectedClusterDir.replace(/^file:\/\//, ""))
    return actualPath === expectedPath
  }
  return true
}

export const isProcessPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  return match(
    Result.try({
      try: () => {
        process.kill(pid, 0)
        return true
      },
      catch: (err) => {
        const code =
          typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
            ? err.code
            : undefined
        return code === "EPERM"
      },
    }),
  )
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()
}

const stripYamlLineComment = (line: string): string => {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle && line[i - 1] !== "\\") {
      inDouble = !inDouble
      continue
    }
    if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, i)
    }
  }
  return line
}

const isNonEmptyYamlInlineValue = (rawValue: string): boolean => {
  const val = rawValue.trim()
  if (
    val.length === 0 ||
    val === "null" ||
    val === "~" ||
    val === "[]" ||
    val === "{}" ||
    val === '""' ||
    val === "''"
  ) {
    return false
  }
  if (val.startsWith("[") && val.endsWith("]")) {
    return val.slice(1, -1).trim().length > 0
  }
  if (val.startsWith("{") && val.endsWith("}")) {
    return val.slice(1, -1).trim().length > 0
  }
  return true
}

export const clusterYamlDeclaresPolicies = (clusterYaml: string): boolean => {
  const lines = clusterYaml.split(/\r?\n/).map(stripYamlLineComment)
  const strippedAll = lines.join("\n")
  const flowMatch = strippedAll.match(/\bpolicies\s*:\s*(\[[^\]]*\]|\{[^}]*\})/)
  if (flowMatch?.[1] !== undefined) {
    return isNonEmptyYamlInlineValue(flowMatch[1])
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const keyMatch = line.match(/^(\s*)policies\s*:\s*(.*)$/)
    if (keyMatch === null) continue
    const keyIndent = keyMatch[1]?.length ?? 0
    const rest = (keyMatch[2] ?? "").trim()
    if (rest.length > 0) {
      if (isNonEmptyYamlInlineValue(rest)) {
        return true
      }
      continue
    }
    let followedByMappingKey = false
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j] ?? ""
      if (nextLine.trim().length === 0) continue
      const nextIndent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0
      const trimmedNext = nextLine.trimStart()
      if (nextIndent > keyIndent) {
        return true
      }
      if (nextIndent === keyIndent && (trimmedNext === "-" || trimmedNext.startsWith("- "))) {
        return true
      }
      if (nextIndent <= keyIndent && /^[A-Za-z0-9_.-]+\s*:/.test(trimmedNext) && !trimmedNext.startsWith("-")) {
        followedByMappingKey = true
        break
      }
      return true
    }
    if (!followedByMappingKey) {
      return true
    }
  }
  return false
}

export const countImplEffectFns = (
  graph: HarnessGraph,
): { readonly implEffectFnCount: number; readonly remainingStubCount: number } => {
  let implEffectFnCount = 0
  let remainingStubCount = 0
  for (const [, node] of Graph.nodes(graph.graph)) {
    match(node)
      .with({ _tag: "EffectFn" }, (fnNode) => {
        implEffectFnCount += 1
        if (fnNode.isStub) {
          remainingStubCount += 1
        }
      })
      .with(
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
  }
  return { implEffectFnCount, remainingStubCount }
}

export const findFirstVitestCaseId = (graph: HarnessGraph): string | undefined => {
  for (const [, node] of Graph.nodes(graph.graph)) {
    const found = match(node)
      .with({ _tag: "VitestCase" }, (vc) => vc.testId)
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => undefined,
      )
      .exhaustive()
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

export const readIsStubFromImage = (
  image: { readonly properties: unknown } | null | undefined,
): boolean => {
  if (image === null || image === undefined) return false
  const props = image.properties
  if (typeof props !== "object" || props === null) return false
  return "isStub" in props && (props as { readonly isStub?: unknown }).isStub === true
}

export const readEffectFnStubAfterFromImage = (
  image: { readonly properties: unknown } | null | undefined,
): boolean => {
  if (image === null || image === undefined) return false
  const props = image.properties
  if (typeof props !== "object" || props === null || !("isStub" in props)) return true
  return (props as { readonly isStub?: unknown }).isStub !== false
}

export const readSpanNameFromImages = (
  before: { readonly properties: unknown } | null | undefined,
  after: { readonly properties: unknown } | null | undefined,
): OmnigraphSpanName | undefined => {
  for (const image of [after, before]) {
    if (image === null || image === undefined) continue
    const props = image.properties
    if (typeof props !== "object" || props === null) continue
    if ("spanName" in props) {
      const candidate = (props as { readonly spanName?: unknown }).spanName
      const decoded = Schema.decodeUnknownOption(OmnigraphSpanName)(candidate)
      const matched = match(decoded)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (matched !== undefined) {
        return matched
      }
    }
  }
  return undefined
}

const BRANCH_NOT_FOUND_CODE_PATTERN = /^(not[_-]?found|branch[_-]?not[_-]?found|unknown[_-]?branch)$/i
const BRANCH_NOT_FOUND_MESSAGE_PATTERN = /\bbranch\b.*(not\s+found|unknown|does\s+not\s+exist)|(?:not\s+found|unknown|does\s+not\s+exist).*\bbranch\b/i

export const isBranchNotFoundError = (err: unknown): boolean => {
  const inner =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { readonly cause?: unknown }).cause
      : err
  for (const candidate of [inner, err]) {
    if (typeof candidate === "object" && candidate !== null) {
      const errCode = Reflect.get(candidate, "code")
      const errMessage = Reflect.get(candidate, "message")
      if (typeof errCode === "string" && BRANCH_NOT_FOUND_CODE_PATTERN.test(errCode)) {
        return true
      }
      if (typeof errMessage === "string" && BRANCH_NOT_FOUND_MESSAGE_PATTERN.test(errMessage)) {
        return true
      }
    }
  }
  return BRANCH_NOT_FOUND_MESSAGE_PATTERN.test(String(err))
}

export const resolveDefaultOmnigraphBin = (): string =>
  join(process.env.HOME ?? "/root", ".local", "bin", "omnigraph")

export const runOmnigraphOptimizeAndCleanup = (
  clusterRootDir: string,
  omnigraphBin: string = resolveDefaultOmnigraphBin(),
  includeCleanup = true,
): void => {
  if (!nodeSyncHostIo.existsSync(clusterRootDir)) {
    return
  }
  if (!nodeSyncHostIo.existsSync(omnigraphBin)) {
    process.stderr.write(
      `[harness:omnigraph] Warning: omnigraph binary not found at ${omnigraphBin}; skipping cluster optimize/cleanup\n`,
    )
    return
  }
  const targetUri = `file://${clusterRootDir}`
  const commands: ReadonlyArray<ReadonlyArray<string>> = includeCleanup
    ? [
        ["optimize", "--target", targetUri, "--graph", "harness"],
        ["cleanup", "--target", targetUri, "--graph", "harness", "--keep", "5", "--confirm"],
      ]
    : [["optimize", "--target", targetUri, "--graph", "harness"]]
  for (const args of commands) {
    const subcommand = args[0] ?? "optimize"
    const execAttempt = Result.try(() =>
      nodeSyncHostIo.execFileSync(omnigraphBin, [...args], { timeoutMs: 15_000 }),
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
            const combined = stderr || stdout
            if (exitCode !== 0) {
              const msg = combined.includes("[state_lock_held]")
                ? `[harness:omnigraph] Info: skipped offline omnigraph ${subcommand} because cluster state lock is held by running omnigraph-server\n`
                : `[harness:omnigraph] Warning: omnigraph ${subcommand} exited ${exitCode}: ${combined}\n`
              process.stderr.write(msg)
            }
          })
          .with({ _tag: "TimedOut" }, ({ stderr }) => {
            process.stderr.write(`[harness:omnigraph] Warning: omnigraph ${subcommand} timed out: ${stderr}\n`)
          })
          .with({ _tag: "Signaled" }, ({ signal, stderr }) => {
            process.stderr.write(`[harness:omnigraph] Warning: omnigraph ${subcommand} killed by ${signal}: ${stderr}\n`)
          })
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => {
            process.stderr.write(`[harness:omnigraph] Warning: omnigraph ${subcommand} spawn failed: ${spawnError}\n`)
          })
          .exhaustive()
      })
      .exhaustive()
  }
}

export type ReadyzProbeResult =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "NotReady"; readonly reason: string }

const ReadyzBodySchema = Schema.Struct({
  ready: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.String),
  ready_graph_count: Schema.optional(Schema.Finite),
})
const decodeReadyzBody = Schema.decodeUnknownOption(ReadyzBodySchema)

export function probeOmnigraphServerReady(baseUrl: string): Effect.Effect<ReadyzProbeResult> {
  return Effect.tryPromise({
    try: () =>
      globalThis
        .fetch(`${baseUrl}/readyz`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        })
        .then((r): Promise<ReadyzProbeResult> =>
          match(r.status)
            .with(200, () => {
              const apiHeader = r.headers.get("Omnigraph-Http-Api")
              if (apiHeader !== "0.14") {
                void r.body?.cancel().catch(() => undefined)
                return Promise.resolve<ReadyzProbeResult>({
                  _tag: "NotReady",
                  reason: `unexpected Omnigraph-Http-Api header: ${String(apiHeader)}`,
                })
              }
              return r.json().then((rawBody: unknown): ReadyzProbeResult =>
                match(decodeReadyzBody(rawBody))
                  .with({ _tag: "None" }, () => ({
                    _tag: "NotReady" as const,
                    reason: "decode mismatch: /readyz body failed schema check",
                  }))
                  .with({ _tag: "Some" }, ({ value: body }) => {
                    const isReady =
                      (body.ready === true || body.status === "serving") &&
                      (body.ready_graph_count ?? 0) >= 1
                    return isReady
                      ? { _tag: "Ready" as const }
                      : {
                          _tag: "NotReady" as const,
                          reason: `not ready (ready=${String(body.ready)}, status=${String(body.status)}, ready_graph_count=${String(body.ready_graph_count)})`,
                        }
                  })
                  .exhaustive(),
              )
            })
            .otherwise((status) => {
              void r.body?.cancel().catch(() => undefined)
              return Promise.resolve<ReadyzProbeResult>({
                _tag: "NotReady",
                reason: `HTTP ${status}`,
              })
            }),
        )
        .catch((err: unknown): ReadyzProbeResult => ({
          _tag: "NotReady",
          reason: `network error: ${err instanceof Error ? err.message : String(err)}`,
        })),
    catch: (err): ReadyzProbeResult => ({
      _tag: "NotReady",
      reason: `network error: ${err instanceof Error ? err.message : String(err)}`,
    }),
  }).pipe(Effect.catch((err) => Effect.succeed<ReadyzProbeResult>(err)))
}

export const readExistingSpanTraceBlobIfSpansMissing = (
  repoRoot: string,
  clusterRepoRoot: string,
  branchName: string,
  graph: HarnessGraph,
  syncLayer: ReturnType<typeof makeOmnigraphSyncLayer>,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const spansPath = join(repoRoot, ".harness", "spans.jsonl")
    if (nodeSyncHostIo.existsSync(spansPath)) return undefined
    const firstTestId = findFirstVitestCaseId(graph)
    if (firstTestId === undefined) return undefined
    const ogSync = yield* OmnigraphSync.pipe(Effect.provide(syncLayer))
    const existing = yield* ogSync
      .getBlobText({
        repoRoot: clusterRepoRoot,
        entity: "node" as const,
        type: OmnigraphTypeName.make("VitestCase"),
        id: OmnigraphEntityId.make(firstTestId),
        property: "spanTraceBlob" as const,
        branch: OmnigraphBranchName.make(branchName),
      })
      .pipe(Effect.orElseSucceed(() => null))
    return typeof existing === "string" ? existing : undefined
  })

export const uploadAndVerifySpanTraceBlob = (
  repoRoot: string,
  clusterRepoRoot: string,
  branchName: string,
  graph: HarnessGraph,
  syncLayer: ReturnType<typeof makeOmnigraphSyncLayer>,
  phaseLabel: "verify" | "done",
  failExitCode: number,
  blockDecision?: string,
  fallbackBlobData?: string,
): Effect.Effect<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
} | undefined> =>
  Effect.gen(function* () {
    const spansPath = join(repoRoot, ".harness", "spans.jsonl")
    const hasSpansFile = nodeSyncHostIo.existsSync(spansPath)
    if (!hasSpansFile && fallbackBlobData === undefined) return undefined
    const firstTestId = findFirstVitestCaseId(graph)
    if (firstTestId === undefined) return undefined
    const makeFail = (reason: string) => ({
      exitCode: failExitCode,
      stdout:
        blockDecision !== undefined ? JSON.stringify({ decision: blockDecision, reason }) : "",
      stderr: `[GATE FAILURE] ${phaseLabel}:omnigraph-span-blob\n${reason}`,
    })
    const readOutcome = hasSpansFile
      ? match(Result.try(() => nodeSyncHostIo.readTextSync(spansPath)))
          .with({ _tag: "Success" }, ({ success }) => ({ ok: true as const, data: success }))
          .with({ _tag: "Failure" }, ({ failure }) => ({
            ok: false as const,
            reason: `Failed to read ${spansPath}: ${failure instanceof Error ? failure.message : String(failure)}`,
          }))
          .exhaustive()
      : { ok: true as const, data: fallbackBlobData ?? "" }
    if (!readOutcome.ok) return makeFail(readOutcome.reason)

    const blobSelector = {
      repoRoot: clusterRepoRoot,
      entity: "node" as const,
      type: OmnigraphTypeName.make("VitestCase"),
      id: OmnigraphEntityId.make(firstTestId),
      property: "spanTraceBlob" as const,
      branch: OmnigraphBranchName.make(branchName),
    }
    const ogSync = yield* OmnigraphSync.pipe(Effect.provide(syncLayer))
    const putOutcome = yield* ogSync
      .putBlob({ ...blobSelector, data: readOutcome.data })
      .pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catch((err) =>
          Effect.succeed({ ok: false as const, reason: `putBlob failed: ${String(err)}` }),
        ),
      )
    if (!putOutcome.ok) return makeFail(putOutcome.reason)

    const statOutcome = yield* ogSync.statBlob(blobSelector).pipe(
      Effect.map((stat) =>
        match(stat.status)
          .with(200, () => ({ ok: true as const }))
          .otherwise((status) => ({ ok: false as const, reason: `statBlob returned status ${status}` })),
      ),
      Effect.catch((err) =>
        Effect.succeed({ ok: false as const, reason: `statBlob failed: ${String(err)}` }),
      ),
    )
    return statOutcome.ok ? undefined : makeFail(statOutcome.reason)
  })

export const formatDiffErrorMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "cause" in err) {
    const inner = (err as { readonly cause?: unknown }).cause
    if (inner instanceof Error) return inner.message
    if (typeof inner === "string") return inner
  }
  return err instanceof Error ? err.message : String(err)
}
