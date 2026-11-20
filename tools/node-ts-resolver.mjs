import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs"
import { constants as moduleConstants, enableCompileCache, register } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const resolveDefaultCompileCacheDir = (
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
) =>
  join(
    tmpdir(),
    uid !== undefined
      ? `effect-harness-v8-compile-cache-${uid}`
      : "effect-harness-v8-compile-cache",
  )

const lstatOrUndefined = (targetPath) => {
  try {
    return lstatSync(targetPath)
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return undefined
    }
    throw err
  }
}

export const initCompileCache = (
  enableFn = enableCompileCache,
  cacheDir = process.env.NODE_COMPILE_CACHE ?? resolveDefaultCompileCacheDir(),
  statusConstants = moduleConstants?.compileCacheStatus,
  stderr = process.stderr,
) => {
  if (typeof enableFn !== "function") return null
  try {
    const failedStatus = statusConstants?.FAILED ?? 0
    const myUid = typeof process.getuid === "function" ? process.getuid() : undefined
    let st = lstatOrUndefined(cacheDir)
    if (st !== undefined) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        stderr.write(
          `[node-ts-resolver] warning: refusing symlink or non-directory V8 compile cache at '${cacheDir}'\n`,
        )
        return { status: failedStatus, message: "symlink or non-directory compile cache path" }
      }
      if (myUid !== undefined && st.uid !== myUid) {
        stderr.write(
          `[node-ts-resolver] warning: refusing V8 compile cache owned by uid ${st.uid} at '${cacheDir}'\n`,
        )
        return { status: failedStatus, message: `compile cache owned by uid ${st.uid}` }
      }
      if ((st.mode & 0o077) !== 0) {
        chmodSync(cacheDir, 0o700)
        st = lstatOrUndefined(cacheDir)
        if (
          st === undefined ||
          st.isSymbolicLink() ||
          !st.isDirectory() ||
          (myUid !== undefined && st.uid !== myUid) ||
          (st.mode & 0o077) !== 0
        ) {
          stderr.write(
            `[node-ts-resolver] warning: failed to enforce 0700 permissions on V8 compile cache at '${cacheDir}'\n`,
          )
          return { status: failedStatus, message: "unsafe compile cache directory permissions" }
        }
      }
    } else if (enableFn === enableCompileCache) {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
      st = lstatOrUndefined(cacheDir)
      if (
        st === undefined ||
        st.isSymbolicLink() ||
        !st.isDirectory() ||
        (myUid !== undefined && st.uid !== myUid)
      ) {
        stderr.write(
          `[node-ts-resolver] warning: created V8 compile cache failed ownership/symlink checks at '${cacheDir}'\n`,
        )
        return { status: failedStatus, message: "created compile cache failed safety checks" }
      }
      if ((st.mode & 0o077) !== 0) {
        chmodSync(cacheDir, 0o700)
        st = lstatOrUndefined(cacheDir)
        if (
          st === undefined ||
          st.isSymbolicLink() ||
          !st.isDirectory() ||
          (myUid !== undefined && st.uid !== myUid) ||
          (st.mode & 0o077) !== 0
        ) {
          stderr.write(
            `[node-ts-resolver] warning: created V8 compile cache failed permission checks at '${cacheDir}'\n`,
          )
          return { status: failedStatus, message: "created compile cache failed safety checks" }
        }
      }
    }

    const result = enableFn(cacheDir)
    if (
      result &&
      typeof result === "object" &&
      statusConstants &&
      result.status === statusConstants.FAILED
    ) {
      const detail = result.message ? `: ${result.message}` : ""
      stderr.write(
        `[node-ts-resolver] warning: failed to enable V8 compile cache at '${cacheDir}'${detail}\n`,
      )
    }
    return result ?? null
  } catch (error) {
    // Safe to continue without V8 compile cache when the host Node runtime or
    // filesystem rejects enabling it; module resolution still succeeds uncached.
    const detail = error instanceof Error ? error.message : String(error)
    stderr.write(
      `[node-ts-resolver] warning: enableCompileCache threw for '${cacheDir}': ${detail}\n`,
    )
    return null
  }
}

initCompileCache()

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const ensureTrailingSlash = (href) => (href.endsWith("/") ? href : `${href}/`)
const repoRootUrl = ensureTrailingSlash(pathToFileURL(repoRoot).href)

const resolveMainRepoRoot = (root) => {
  try {
    const dotGit = join(root, ".git")
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const content = readFileSync(dotGit, "utf-8").trim()
      const match = /^gitdir:\s*(.+)$/.exec(content)
      if (match?.[1]) {
        const gitDir = resolvePath(root, match[1].trim())
        const commondirPath = join(gitDir, "commondir")
        const candidateMain = existsSync(commondirPath)
          ? resolvePath(resolvePath(gitDir, readFileSync(commondirPath, "utf-8").trim()), "..")
          : resolvePath(gitDir, "..", "..", "..")
        if (existsSync(join(candidateMain, "node_modules"))) {
          return candidateMain
        }
      }
    }
  } catch {
    // Safe to fall back to null: .git may be absent, unreadable, or a directory in
    // non-worktree checkouts, in which case worktree mainRepoRoot fallback is unneeded.
  }
  return null
}

const mainRepoRoot = resolveMainRepoRoot(repoRoot)

const WORKSPACE_PACKAGE_PATHS = {
  "@harness/contract": "libs/harness/contract/src/index.ts",
  "@harness/service": "libs/harness/service/src/index.ts",
  "@harness/service/host-io": "libs/harness/service/src/host-io.ts",
  "@harness/service/testing": "libs/harness/service/test/test-host-io.ts",
  "@harness/infra": "libs/harness/infra/src/index.ts",
  "@harness/infra/hook-fastpath": "libs/harness/infra/src/hook-fastpath.ts",
  "@harness/infra/hook-io": "libs/harness/infra/src/hook-io.ts",
  "@harness/gates": "libs/harness/gates/src/index.ts",
  "@harness/gates/hook-fastpath": "libs/harness/gates/src/hook-fastpath.ts",
  "@harness/gates/policy": "libs/harness/gates/src/policy.ts",
  "@harness/decision": "libs/harness/decision/src/index.ts",
  "@harness/decision/hook-fastpath": "libs/harness/decision/src/hook-fastpath.ts",
  "@harness/ingest": "libs/harness/ingest/src/index.ts",
  "@harness/graph": "libs/harness/graph/src/index.ts",
  "@harness/graph/cluster-resolver": "libs/harness/graph/src/cluster-resolver.ts",
  "@harness/sample-contract": "libs/sample/contract/src/index.ts",
  "@harness/sample-service": "libs/sample/service/src/index.ts",
  "@harness/sample-domain": "libs/sample/domain/src/index.ts",
  "@harness/sample-infra": "libs/sample/infra/src/index.ts",
}

const WORKSPACE_PACKAGE_WILDCARDS = []

const extractExportTarget = (val) => {
  if (typeof val === "string") return val
  if (val && typeof val === "object") {
    return extractExportTarget(val.import ?? val.default ?? val.types ?? null)
  }
  return null
}

const toWorkspaceSourceRel = (pkgRelDir, rawTarget) => {
  if (typeof rawTarget !== "string") return null
  const normalized = rawTarget.replace(/^\.\//, "")
  if (normalized.startsWith("dist/") && normalized.endsWith(".js")) {
    const stem = normalized.slice("dist/".length, -3)
    const tsCandidate = `${pkgRelDir}/src/${stem}.ts`
    if (stem.includes("*") || existsSync(join(repoRoot, tsCandidate))) return tsCandidate
    const tsxCandidate = `${pkgRelDir}/src/${stem}.tsx`
    if (existsSync(join(repoRoot, tsxCandidate))) return tsxCandidate
    return tsCandidate
  }
  if (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) {
    return `${pkgRelDir}/${normalized}`
  }
  return null
}

const indexPackageManifest = (pkgRelDir) => {
  const pkgJsonPath = join(repoRoot, pkgRelDir, "package.json")
  if (!existsSync(pkgJsonPath)) return
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"))
    const pkgName = typeof pkg?.name === "string" ? pkg.name : null
    if (!pkgName || !pkg.exports || typeof pkg.exports !== "object") return
    for (const [subpath, rawVal] of Object.entries(pkg.exports)) {
      const targetStr = extractExportTarget(rawVal)
      const sourceRel = toWorkspaceSourceRel(pkgRelDir, targetStr)
      if (!sourceRel) continue
      const fullSpec = subpath === "." ? pkgName : `${pkgName}/${subpath.replace(/^\.\//, "")}`
      if (fullSpec.includes("*") && sourceRel.includes("*")) {
        const [specPrefix, specSuffix] = fullSpec.split("*")
        const [relPrefix, relSuffix] = sourceRel.split("*")
        WORKSPACE_PACKAGE_WILDCARDS.push({ specPrefix, specSuffix, relPrefix, relSuffix })
      } else if (!(fullSpec in WORKSPACE_PACKAGE_PATHS)) {
        WORKSPACE_PACKAGE_PATHS[fullSpec] = sourceRel
      }
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined
    if (code !== "ENOENT") {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[node-ts-resolver] warning: failed to index '${pkgJsonPath}': ${detail}\n`,
      )
    }
  }
}

try {
  const libsDir = join(repoRoot, "libs")
  if (existsSync(libsDir)) {
    for (const scope of readdirSync(libsDir, { withFileTypes: true })) {
      if (!scope.isDirectory() || scope.name === "node_modules") continue
      const scopeDir = join(libsDir, scope.name)
      for (const pkg of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!pkg.isDirectory() || pkg.name === "node_modules") continue
        indexPackageManifest(`libs/${scope.name}/${pkg.name}`)
      }
    }
  }
  const appsDir = join(repoRoot, "apps")
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir, { withFileTypes: true })) {
      if (!app.isDirectory() || app.name === "node_modules") continue
      indexPackageManifest(`apps/${app.name}`)
    }
  }
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined
  if (code !== "ENOENT") {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[node-ts-resolver] warning: failed to enumerate workspace packages under '${repoRoot}': ${detail}\n`,
    )
  }
}

const resolveDynamicExport = (specifier) => {
  const direct = WORKSPACE_PACKAGE_PATHS[specifier]
  if (direct !== undefined) return direct
  for (const wc of WORKSPACE_PACKAGE_WILDCARDS) {
    if (
      specifier.startsWith(wc.specPrefix) &&
      specifier.endsWith(wc.specSuffix) &&
      specifier.length >= wc.specPrefix.length + wc.specSuffix.length
    ) {
      const star = specifier.slice(wc.specPrefix.length, specifier.length - wc.specSuffix.length)
      return `${wc.relPrefix}${star}${wc.relSuffix}`
    }
  }
  return undefined
}

const resolveTsOrTsxUrl = (specifier, parentURL) => {
  const literalUrl = new URL(specifier, parentURL)
  if (literalUrl.protocol !== "file:" || !literalUrl.pathname.endsWith(".js")) return null
  if (existsSync(fileURLToPath(literalUrl))) return null
  for (const ext of [".ts", ".tsx"]) {
    const candidate = new URL(literalUrl.href)
    candidate.pathname = `${literalUrl.pathname.slice(0, -3)}${ext}`
    if (existsSync(fileURLToPath(candidate))) return candidate
  }
  return null
}

const logResolverFallback = (specifier, error, stage) => {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined
  const isExpectedNotFound = code === "ERR_MODULE_NOT_FOUND" || code === "ENOENT"
  if (!isExpectedNotFound || process.env.HARNESS_DEBUG_RESOLVER === "1") {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[node-ts-resolver] ${stage} fallback for '${specifier}'${code ? ` (${code})` : ""}: ${detail}\n`,
    )
  }
}

export async function resolve(specifier, context, nextResolve) {
  const workspaceRel = resolveDynamicExport(specifier)
  if (workspaceRel !== undefined) {
    const targetPath = join(repoRoot, workspaceRel)
    if (existsSync(targetPath)) {
      return nextResolve(pathToFileURL(targetPath).href, context)
    }
  }

  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith(repoRootUrl) &&
    !context.parentURL.includes("/node_modules/") &&
    !context.parentURL.includes("/repos/")
  ) {
    const tsUrl = resolveTsOrTsxUrl(specifier, context.parentURL)
    if (tsUrl !== null) {
      return nextResolve(tsUrl.href, context)
    }
  }

  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    logResolverFallback(specifier, error, "primary")
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file://")
    ) {
      const tsUrl = resolveTsOrTsxUrl(specifier, context.parentURL)
      if (tsUrl !== null) {
        return nextResolve(tsUrl.href, context)
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
      const mainRepoRootUrl = ensureTrailingSlash(pathToFileURL(mainRepoRoot).href)
      const mappedParentURL =
        typeof context.parentURL === "string" && context.parentURL.startsWith(repoRootUrl)
          ? mainRepoRootUrl + context.parentURL.slice(repoRootUrl.length)
          : pathToFileURL(join(mainRepoRoot, "apps/harness-cli/package.json")).href
      try {
        return await nextResolve(specifier, {
          ...context,
          parentURL: mappedParentURL,
        })
      } catch (fallbackError) {
        logResolverFallback(specifier, fallbackError, "worktree-parent")
        return nextResolve(specifier, {
          ...context,
          parentURL: pathToFileURL(join(mainRepoRoot, "apps/harness-cli/package.json")).href,
        })
      }
    }
    throw error
  }
}

const currentPid = String(process.pid)
if (process.env.__HARNESS_TS_RESOLVER_REGISTERED !== currentPid) {
  process.env.__HARNESS_TS_RESOLVER_REGISTERED = currentPid
  register(pathToFileURL(fileURLToPath(import.meta.url)))
}
