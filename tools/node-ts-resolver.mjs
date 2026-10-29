import { existsSync, readFileSync, statSync } from "node:fs"
import { register } from "node:module"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const resolveMainRepoRoot = (root) => {
  try {
    const dotGit = join(root, ".git")
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const content = readFileSync(dotGit, "utf-8").trim()
      const match = /^gitdir:\s*(.+)$/.exec(content)
      if (match?.[1]) {
        const gitDir = resolvePath(root, match[1].trim())
        const candidateMain = resolvePath(gitDir, "..", "..", "..")
        if (existsSync(join(candidateMain, "node_modules"))) {
          return candidateMain
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

const mainRepoRoot = resolveMainRepoRoot(repoRoot)

const WORKSPACE_PACKAGE_PATHS = {
  "@harness/gates": "libs/harness/gates/src/index.ts",
  "@harness/decision": "libs/harness/decision/src/index.ts",
  "@harness/ingest": "libs/harness/ingest/src/index.ts",
  "@harness/graph": "libs/harness/graph/src/index.ts",
  "@harness/sample-contract": "libs/sample/contract/src/index.ts",
  "@harness/sample-service": "libs/sample/service/src/index.ts",
  "@harness/sample-domain": "libs/sample/domain/src/index.ts",
  "@harness/sample-infra": "libs/sample/infra/src/index.ts"
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.endsWith(".js") && context.parentURL?.startsWith("file://")) {
      const tsUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL)
      if (existsSync(fileURLToPath(tsUrl))) {
        return nextResolve(tsUrl.href, context)
      }
    }
    const workspaceRel = WORKSPACE_PACKAGE_PATHS[specifier]
    if (workspaceRel !== undefined) {
      const targetPath = join(repoRoot, workspaceRel)
      if (existsSync(targetPath)) {
        return nextResolve(pathToFileURL(targetPath).href, context)
      }
    }
    const scopedMatch =
      /^@harness\/([a-z0-9-]+)-(contract|service|domain|core|infra)$/.exec(specifier) ??
      /^@effect-([a-z0-9-]+)\/(contract|service|domain|core|infra)$/.exec(specifier)
    if (scopedMatch !== null) {
      const [, scope, tier] = scopedMatch
      const dynamicTarget = join(repoRoot, "libs", scope, tier, "src", "index.ts")
      if (existsSync(dynamicTarget)) {
        return nextResolve(pathToFileURL(dynamicTarget).href, context)
      }
    }
    if (mainRepoRoot !== null) {
      return nextResolve(specifier, {
        ...context,
        parentURL: pathToFileURL(join(mainRepoRoot, "package.json")).href
      })
    }
    throw error
  }
}

const currentPid = String(process.pid)
if (process.env.__HARNESS_TS_RESOLVER_REGISTERED !== currentPid) {
  process.env.__HARNESS_TS_RESOLVER_REGISTERED = currentPid
  register(pathToFileURL(fileURLToPath(import.meta.url)))
}
