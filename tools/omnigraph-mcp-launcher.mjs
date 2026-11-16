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
    // Fall back to absRoot
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
  } catch {
    return undefined
  }
}

function readSafeMcpToken(tokensPath) {
  try {
    if (!existsSync(tokensPath)) return undefined
    const mode = statSync(tokensPath).mode & 0o777
    if ((mode & 0o077) !== 0) {
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
  } catch {
    return undefined
  }
  return undefined
}

const workspaceRoot = findWorkspaceRoot(process.cwd())
const clusterRepoRoot = resolveCanonicalRepoRoot(workspaceRoot)
const clusterDir = join(clusterRepoRoot, ".harness", "omnigraph-cluster")
const fallbackPort = deriveRepoOmnigraphPort(clusterRepoRoot)
const fallbackUrl = `http://127.0.0.1:${fallbackPort}`

const serverMeta = readJsonSafe(join(clusterDir, "server.json"))
const validServerUrl =
  typeof serverMeta?.baseUrl === "string" &&
  isLoopbackUrl(serverMeta.baseUrl) &&
  serverMeta?.canonicalRepoRoot === clusterRepoRoot &&
  isPidAlive(serverMeta?.pid)
    ? serverMeta.baseUrl
    : undefined

const explicitEnvUrl = [process.env.OMNIGRAPH_URL, process.env.OMNIGRAPH_BASE_URL].find(
  (u) => typeof u === "string" && u.length > 0 && u !== "http://127.0.0.1:8080",
)

const resolvedUrl = explicitEnvUrl ?? validServerUrl ?? fallbackUrl

const resolvedToken = isLoopbackUrl(resolvedUrl)
  ? (process.env.OMNIGRAPH_TOKEN ?? readSafeMcpToken(join(clusterDir, "auth-tokens.json")))
  : undefined

const childEnv = {
  ...process.env,
  OMNIGRAPH_URL: resolvedUrl,
  OMNIGRAPH_BASE_URL: resolvedUrl,
  ...(resolvedToken !== undefined ? { OMNIGRAPH_TOKEN: resolvedToken } : {}),
}

const child = spawn("npx", ["-y", "@modernrelay/omnigraph-mcp@0.14.0"], {
  stdio: "inherit",
  env: childEnv,
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
