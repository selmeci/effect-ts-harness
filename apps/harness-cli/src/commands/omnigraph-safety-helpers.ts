import { basename, resolve } from "node:path"
import { Result } from "effect"
import { match } from "ts-pattern"
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
