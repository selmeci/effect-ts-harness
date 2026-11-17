#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

function findWorkspaceRoot(startDir) {
  let curr = resolve(startDir)
  while (curr !== dirname(curr)) {
    if (existsSync(join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = dirname(curr)
  }
  return resolve(import.meta.dirname, "..")
}

function resolveCanonicalRepoRoot(repoRoot) {
  const absRoot = resolve(repoRoot)
  try {
    const dotGit = join(absRoot, ".git")
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const content = readFileSync(dotGit, "utf8").trim()
      if (content.startsWith("gitdir:")) {
        const rawGitDir = content.slice("gitdir:".length).trim()
        const gitDir = resolve(absRoot, rawGitDir)
        const commonDirFile = join(gitDir, "commondir")
        if (existsSync(commonDirFile)) {
          const commondir = readFileSync(commonDirFile, "utf8").trim()
          const commonGitDir = resolve(gitDir, commondir)
          if (basename(commonGitDir) === ".git") {
            return dirname(commonGitDir)
          }
        }
        const match = gitDir.match(/^(.*?)[/\\]\.git[/\\]worktrees([/\\]|$)/)
        if (match && match[1]) {
          return match[1]
        }
      }
    }
  } catch {
  }
  return absRoot
}

function deriveRepoOmnigraphPort(canonicalRoot) {
  const hash = createHash("sha256").update(canonicalRoot).digest()
  return 18080 + (hash.readUInt16BE(0) % 10000)
}

function isLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (parsed.username !== "" || parsed.password !== "") return false
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    )
  } catch {
    return false
  }
}

function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return typeof err === "object" && err !== null && err.code === "EPERM"
  }
}

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return undefined
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch (err) {
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: failed to read/parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return undefined
  }
}

function readSafeMcpToken(tokensPath) {
  try {
    if (!existsSync(tokensPath)) return undefined
    const mode = statSync(tokensPath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      process.stderr.write(
        `[omnigraph-mcp-launcher] Warning: refusing ${tokensPath} with permissive mode ${mode.toString(8)}\n`,
      )
      return undefined
    }
    const parsed = JSON.parse(readFileSync(tokensPath, "utf8"))
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      parsed.schemaVersion === 1 &&
      typeof parsed.mcpToken === "string" &&
      parsed.mcpToken.length > 0
    ) {
      return parsed.mcpToken
    }
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: invalid auth-tokens.json schema at ${tokensPath}\n`,
    )
  } catch (err) {
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: failed to read/parse ${tokensPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return undefined
  }
  return undefined
}

const workspaceRoot = findWorkspaceRoot(process.cwd())
const clusterRepoRoot = resolveCanonicalRepoRoot(workspaceRoot)
const clusterDir = join(clusterRepoRoot, ".harness", "omnigraph-cluster")
const fallbackPort = deriveRepoOmnigraphPort(clusterRepoRoot)
const fallbackUrl = `http://127.0.0.1:${fallbackPort}`

const serverJsonPath = join(clusterDir, "server.json")
const serverJsonExists = existsSync(serverJsonPath)
const serverMeta = readJsonSafe(serverJsonPath)
let validServerUrl
if (serverMeta !== undefined) {
  if (typeof serverMeta.baseUrl !== "string" || !isLoopbackUrl(serverMeta.baseUrl)) {
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: ignoring server.json with non-loopback or invalid baseUrl (${String(serverMeta.baseUrl)})\n`,
    )
  } else if (serverMeta.canonicalRepoRoot !== clusterRepoRoot) {
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: ignoring server.json due to canonicalRepoRoot mismatch (expected ${clusterRepoRoot}, got ${String(serverMeta.canonicalRepoRoot)})\n`,
    )
  } else if (!isPidAlive(serverMeta.pid)) {
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: ignoring server.json with dead pid (${String(serverMeta.pid)})\n`,
    )
  } else {
    validServerUrl = serverMeta.baseUrl
  }
}

const explicitEnvUrl = [process.env.OMNIGRAPH_URL, process.env.OMNIGRAPH_BASE_URL].find(
  (u) => typeof u === "string" && u.length > 0 && u !== "http://127.0.0.1:8080",
)

if (explicitEnvUrl === undefined && validServerUrl === undefined) {
  process.stderr.write(
    `[omnigraph-mcp-launcher] Warning: falling back to derived URL ${fallbackUrl} (${serverJsonExists ? "server.json invalid or dead PID" : "server.json missing"})\n`,
  )
  try {
    const probeRes = await fetch(`${fallbackUrl}/readyz`, { signal: AbortSignal.timeout(1000) })
    if (!probeRes.ok) {
      process.stderr.write(
        `[omnigraph-mcp-launcher] Warning: fallback probe ${fallbackUrl}/readyz returned HTTP ${probeRes.status}\n`,
      )
    }
  } catch (err) {
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: fallback probe ${fallbackUrl}/readyz failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

const resolvedUrl = explicitEnvUrl ?? validServerUrl ?? fallbackUrl

const authTokensPath = join(clusterDir, "auth-tokens.json")
const envToken =
  typeof process.env.OMNIGRAPH_TOKEN === "string" && process.env.OMNIGRAPH_TOKEN.length > 0
    ? process.env.OMNIGRAPH_TOKEN
    : undefined
let resolvedToken
if (isLoopbackUrl(resolvedUrl)) {
  if (envToken !== undefined) {
    resolvedToken = envToken
  } else if (existsSync(authTokensPath)) {
    resolvedToken = readSafeMcpToken(authTokensPath)
  } else if (serverJsonExists) {
    process.stderr.write(
      `[omnigraph-mcp-launcher] Warning: OMNIGRAPH_TOKEN is unset and ${authTokensPath} does not exist for initialized cluster\n`,
    )
  }
} else {
  process.stderr.write(
    `[omnigraph-mcp-launcher] Warning: resolved URL ${resolvedUrl} is not loopback; not forwarding OMNIGRAPH_TOKEN to MCP child\n`,
  )
}

const childEnv = {
  ...process.env,
  OMNIGRAPH_URL: resolvedUrl,
  OMNIGRAPH_BASE_URL: resolvedUrl,
}
if (resolvedToken !== undefined) {
  childEnv.OMNIGRAPH_TOKEN = resolvedToken
} else {
  delete childEnv.OMNIGRAPH_TOKEN
}

const child = spawn("npx", ["-y", "@modernrelay/omnigraph-mcp@0.14.0"], {
  stdio: "inherit",
  env: childEnv,
})

child.on("error", (err) => {
  process.stderr.write(
    `[omnigraph-mcp-launcher] Error: failed to spawn MCP server: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
