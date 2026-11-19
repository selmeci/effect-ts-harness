import { basename, resolve } from "node:path"
import { Cause, Effect, Graph, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { OmnigraphSpanName } from "@harness/contract"
import { type HarnessGraph, loadGraphSnapshotEffect } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"

export {
  findFirstVitestCaseId,
  readExistingSpanTraceBlobIfSpansMissing,
  resolveDefaultOmnigraphBin,
  runOmnigraphOptimizeAndCleanup,
  uploadAndVerifySpanTraceBlob,
} from "./omnigraph-lint-gate.js"

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

export const collectPlanEffectFnQualnames = (graph: HarnessGraph): ReadonlySet<string> => {
  const qualnames = new Set<string>()
  for (const [, node] of Graph.nodes(graph.graph)) {
    match(node)
      .with({ _tag: "EffectFn" }, (fnNode) => {
        qualnames.add(fnNode.qualname)
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
  return qualnames
}

export const loadPlanEffectFnQualnames = (
  planSnapshotPath: string,
  hostIo: SyncHostIo,
): Effect.Effect<ReadonlySet<string> | undefined> =>
  Effect.map(Effect.exit(loadGraphSnapshotEffect(planSnapshotPath, hostIo)), (loadExit) =>
    match(loadExit)
      .with({ _tag: "Success" }, ({ value }) => collectPlanEffectFnQualnames(value))
      .with({ _tag: "Failure" }, ({ cause }) => {
        process.stderr.write(
          `[harness:done] Warning: failed to decode plan snapshot '${planSnapshotPath}': ${Cause.pretty(cause)}\n`,
        )
        return undefined
      })
      .exhaustive(),
  )

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

export const formatDiffErrorMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "cause" in err) {
    const inner = (err as { readonly cause?: unknown }).cause
    if (inner instanceof Error) return inner.message
    if (typeof inner === "string") return inner
  }
  return err instanceof Error ? err.message : String(err)
}
