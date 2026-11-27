import { createHash, randomBytes } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import { ts } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra/hook-fastpath"
import { withHookRuntimeBuildLock } from "./hook-runtime-lock.js"
import { isInsideRoot } from "./repo-path.js"

const SNAPSHOT_PACKAGE_DIRS: ReadonlyArray<string> = [
  "libs/harness/contract",
  "libs/harness/service",
  "libs/harness/gates",
  "libs/harness/decision",
  "libs/harness/infra",
  "libs/harness/graph",
  "libs/harness/ingest",
  "apps/harness-cli",
]

const REQUIRED_ENTRYPOINT_RELS: ReadonlyArray<string> = [
  "apps/harness-cli/src/hook-entry.js",
  "libs/harness/gates/src/policy.js",
]

const HookRuntimeManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  builtAt: Schema.NonEmptyString,
  entryRel: Schema.NonEmptyString,
  packageMap: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString),
  fileHashes: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString),
})
export type HookRuntimeManifest = typeof HookRuntimeManifestSchema.Type

const PackageManifestSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Unknown),
})

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(HookRuntimeManifestSchema))
const decodePkgManifest = Schema.decodeUnknownOption(Schema.fromJsonString(PackageManifestSchema))

export type HookRuntimeLoadResult =
  | {
      readonly _tag: "Snapshot"
      readonly snapshotDir: string
      readonly entryPath: string
      readonly packageMap: Readonly<Record<string, string>>
    }
  | {
      readonly _tag: "SourceFallback"
      readonly reason: string
    }

export interface LoadHookRuntimeOptions {
  readonly forceSource?: boolean | undefined
}

export type BuildHookRuntimeSnapshotResult =
  | {
      readonly _tag: "Built"
      readonly snapshotDir: string
      readonly manifestPath: string
      readonly fileCount: number
      readonly manifest: HookRuntimeManifest
    }
  | {
      readonly _tag: "Failed"
      readonly reason: string
    }

const toErrMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const isNonSymlinkContained = (rootReal: string, targetPath: string): boolean => {
  const symRes = Result.try(() => nodeSyncHostIo.isSymbolicLinkSync(targetPath))
  return match(symRes)
    .with({ _tag: "Failure" }, () => false)
    .with({ _tag: "Success" }, ({ success: isSymlink }) => {
      if (isSymlink || !nodeSyncHostIo.existsSync(targetPath)) return false
      const realRes = Result.try(() => nodeSyncHostIo.realpathSync(targetPath))
      return match(realRes)
        .with({ _tag: "Failure" }, () => false)
        .with({ _tag: "Success" }, ({ success: realTarget }) => isInsideRoot(rootReal, realTarget))
        .exhaustive()
    })
    .exhaustive()
}

const ensureSafeDirectory = (rootReal: string, dirPath: string): Result.Result<string, string> =>
  Result.try({
    try: () => {
      if (nodeSyncHostIo.isSymbolicLinkSync(dirPath)) {
        return { ok: false as const, reason: `Refusing symlink directory at '${dirPath}'` }
      }
      if (!nodeSyncHostIo.existsSync(dirPath)) {
        nodeSyncHostIo.mkdirRecursiveSync(dirPath)
      }
      if (nodeSyncHostIo.isSymbolicLinkSync(dirPath) || !nodeSyncHostIo.isDirectorySync(dirPath)) {
        return { ok: false as const, reason: `Expected non-symlink directory at '${dirPath}'` }
      }
      const dirReal = nodeSyncHostIo.realpathSync(dirPath)
      if (!isInsideRoot(rootReal, dirReal)) {
        return {
          ok: false as const,
          reason: `Directory '${dirPath}' escapes containment root '${rootReal}'`,
        }
      }
      return { ok: true as const, dirReal }
    },
    catch: toErrMessage,
  }).pipe(Result.flatMap((res) => (res.ok ? Result.succeed(res.dirReal) : Result.fail(res.reason))))

const collectTsFilesInDir = (
  repoRoot: string,
  absDir: string,
  outRelPaths: Array<string>,
): void => {
  if (!nodeSyncHostIo.existsSync(absDir)) return
  const entries = nodeSyncHostIo.readdirSync(absDir)
  for (const entry of entries) {
    const absChild = join(absDir, entry.name)
    if (nodeSyncHostIo.isSymbolicLinkSync(absChild)) continue
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue
      collectTsFilesInDir(repoRoot, absChild, outRelPaths)
      continue
    }
    if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      outRelPaths.push(relative(repoRoot, absChild).replace(/\\/g, "/"))
    }
  }
}

const extractExportTarget = (val: unknown): string | undefined => {
  if (typeof val === "string") return val
  if (typeof val === "object" && val !== null) {
    const rec = val as {
      readonly import?: unknown
      readonly default?: unknown
      readonly types?: unknown
    }
    if (typeof rec.import === "string") return rec.import
    if (typeof rec.default === "string") return rec.default
    if (typeof rec.types === "string") return rec.types
  }
  return undefined
}

const toSnapshotJsRel = (pkgRelDir: string, rawTarget: string): string | undefined => {
  const normalized = rawTarget.replace(/^\.\//, "")
  if (normalized.startsWith("dist/") && normalized.endsWith(".js")) {
    return `${pkgRelDir}/src/${normalized.slice("dist/".length)}`
  }
  if (normalized.endsWith(".ts") && !normalized.endsWith(".d.ts")) {
    return `${pkgRelDir}/${normalized.slice(0, -3)}.js`
  }
  return undefined
}

const buildSnapshotPackageMap = (
  repoRoot: string,
  emittedJsRels: ReadonlySet<string>,
): Record<string, string> => {
  const packageMap: Record<string, string> = {}
  for (const pkgRelDir of SNAPSHOT_PACKAGE_DIRS) {
    const pkgJsonPath = join(repoRoot, pkgRelDir, "package.json")
    if (!nodeSyncHostIo.existsSync(pkgJsonPath)) continue
    const raw = nodeSyncHostIo.readTextSync(pkgJsonPath)
    match(decodePkgManifest(raw))
      .with({ _tag: "None" }, () => undefined)
      .with({ _tag: "Some" }, ({ value: pkg }) => {
        const pkgName = pkg.name?.trim()
        if (pkgName === undefined || pkgName.length === 0) return
        const exp = pkg.exports
        if (typeof exp === "string") {
          const jsRel = toSnapshotJsRel(pkgRelDir, exp)
          if (jsRel !== undefined && emittedJsRels.has(jsRel)) {
            packageMap[pkgName] = jsRel
          }
          return
        }
        if (typeof exp === "object" && exp !== null) {
          for (const [subKey, subVal] of Object.entries(exp)) {
            const target = extractExportTarget(subVal)
            if (target === undefined) continue
            const jsRel = toSnapshotJsRel(pkgRelDir, target)
            if (jsRel === undefined || !emittedJsRels.has(jsRel)) continue
            if (subKey === ".") {
              packageMap[pkgName] = jsRel
              continue
            }
            if (subKey.startsWith("./")) {
              const suffix = subKey.slice(2)
              packageMap[`${pkgName}/${suffix}`] = jsRel
              if (!suffix.endsWith(".js")) {
                packageMap[`${pkgName}/${suffix}.js`] = jsRel
              }
            }
          }
        }
      })
      .exhaustive()
  }
  return packageMap
}

const TRANSPILE_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  esModuleInterop: true,
  sourceMap: false,
  inlineSourceMap: false,
}

interface TranspileStageOutput {
  readonly emittedJsRels: Set<string>
  readonly fileHashes: Record<string, string>
}

const transpileStageFiles = (
  repoReal: string,
  stagingDir: string,
  tsRelFiles: ReadonlyArray<string>,
): Result.Result<TranspileStageOutput, string> =>
  Result.try({
    try: () => {
      const emittedJsRels = new Set<string>()
      const fileHashes: Record<string, string> = {}
      for (const relTsPath of tsRelFiles) {
        const absTsPath = join(repoReal, relTsPath)
        if (!isNonSymlinkContained(repoReal, absTsPath)) continue
        const sourceText = nodeSyncHostIo.readTextSync(absTsPath)
        const result = ts.transpileModule(sourceText, {
          fileName: absTsPath,
          compilerOptions: TRANSPILE_COMPILER_OPTIONS,
          reportDiagnostics: true,
        })
        const errorDiag = result.diagnostics?.find(
          (d) => d.category === ts.DiagnosticCategory.Error,
        )
        if (errorDiag !== undefined) {
          const msg = ts.flattenDiagnosticMessageText(errorDiag.messageText, "\n")
          return { ok: false as const, reason: `Transpile failed for '${relTsPath}': ${msg}` }
        }
        const relJsPath = `${relTsPath.slice(0, -3)}.js`
        const outAbsPath = join(stagingDir, relJsPath)
        nodeSyncHostIo.mkdirRecursiveSync(dirname(outAbsPath))
        nodeSyncHostIo.writeTextSync(outAbsPath, result.outputText)
        emittedJsRels.add(relJsPath)
        fileHashes[relJsPath] = createHash("sha256").update(result.outputText, "utf8").digest("hex")
      }
      return { ok: true as const, value: { emittedJsRels, fileHashes } }
    },
    catch: toErrMessage,
  }).pipe(Result.flatMap((res) => (res.ok ? Result.succeed(res.value) : Result.fail(res.reason))))

const swapStagedDirectoryAtomic = (
  runtimeRootReal: string,
  stagingDir: string,
): Result.Result<string, string> => {
  const currentDir = join(runtimeRootReal, "current")
  if (nodeSyncHostIo.isSymbolicLinkSync(currentDir)) {
    return Result.fail(`Refusing symlink at '${currentDir}'`)
  }
  const backupRes: Result.Result<string | undefined, string> = nodeSyncHostIo.existsSync(currentDir)
    ? Result.try({
        try: () => {
          const backupDir = join(
            runtimeRootReal,
            `.prev-${process.pid}-${randomBytes(6).toString("hex")}`,
          )
          nodeSyncHostIo.renameSync(currentDir, backupDir)
          return backupDir
        },
        catch: toErrMessage,
      })
    : Result.succeed(undefined)

  return match(backupRes)
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, ({ success: backupDir }) => {
      const swapRes = Result.try({
        try: () => {
          nodeSyncHostIo.renameSync(stagingDir, currentDir)
        },
        catch: toErrMessage,
      })
      return match(swapRes)
        .with({ _tag: "Failure" }, ({ failure }) => {
          if (
            backupDir !== undefined &&
            nodeSyncHostIo.existsSync(backupDir) &&
            !nodeSyncHostIo.existsSync(currentDir)
          ) {
            Result.try(() => nodeSyncHostIo.renameSync(backupDir, currentDir))
          }
          return Result.fail(failure)
        })
        .with({ _tag: "Success" }, () => {
          if (backupDir !== undefined && nodeSyncHostIo.existsSync(backupDir)) {
            Result.try(() => nodeSyncHostIo.rmRecursiveSync(backupDir))
          }
          return Result.succeed(currentDir)
        })
        .exhaustive()
    })
    .exhaustive()
}

/**
 * Transpiles harness hook/runtime TypeScript packages to `.js` in a staged directory
 * and atomically swaps `.harness/hook-runtime/current` (`SPEC-0037 REQ-4.3`).
 */
export const buildHookRuntimeSnapshot = (repoRoot: string): BuildHookRuntimeSnapshotResult => {
  const repoRealRes = Result.try({
    try: () => nodeSyncHostIo.realpathSync(resolve(repoRoot)),
    catch: toErrMessage,
  })
  const runtimeDirsRes = repoRealRes.pipe(
    Result.flatMap((repoReal) =>
      ensureSafeDirectory(repoReal, join(repoReal, ".harness")).pipe(
        Result.flatMap((harnessReal) =>
          ensureSafeDirectory(harnessReal, join(harnessReal, "hook-runtime")).pipe(
            Result.map((runtimeRootReal) => ({ repoReal, runtimeRootReal })),
          ),
        ),
      ),
    ),
  )

  return match(runtimeDirsRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({ _tag: "Failed" as const, reason: failure }))
    .with({ _tag: "Success" }, ({ success: { repoReal, runtimeRootReal } }) => {
      const tsRelFiles: Array<string> = []
      for (const pkgRelDir of SNAPSHOT_PACKAGE_DIRS) {
        collectTsFilesInDir(repoReal, join(repoReal, pkgRelDir, "src"), tsRelFiles)
      }
      const stagingDir = join(
        runtimeRootReal,
        `.staging-${process.pid}-${randomBytes(6).toString("hex")}`,
      )
      const mkRes = Result.try({
        try: () => nodeSyncHostIo.mkdirRecursiveSync(stagingDir),
        catch: toErrMessage,
      })

      return match(mkRes)
        .with({ _tag: "Failure" }, ({ failure }) => ({ _tag: "Failed" as const, reason: failure }))
        .with({ _tag: "Success" }, () => {
          const cleanupStaging = (): void => {
            Result.try(() => nodeSyncHostIo.rmRecursiveSync(stagingDir))
          }

          const buildRes = transpileStageFiles(repoReal, stagingDir, tsRelFiles).pipe(
            Result.flatMap(({ emittedJsRels, fileHashes }) =>
              Result.try({
                try: () => {
                  nodeSyncHostIo.writeTextSync(
                    join(stagingDir, "package.json"),
                    JSON.stringify({ type: "module" }),
                  )
                  const packageMap = buildSnapshotPackageMap(repoReal, emittedJsRels)
                  const manifest: HookRuntimeManifest = {
                    version: 1,
                    builtAt: new Date().toISOString(),
                    entryRel: "apps/harness-cli/src/hook-entry.js",
                    packageMap,
                    fileHashes,
                  }
                  const stagingManifestPath = join(stagingDir, "manifest.json")
                  nodeSyncHostIo.writeTextSync(
                    stagingManifestPath,
                    JSON.stringify(manifest, null, 2),
                  )
                  if (
                    !isNonSymlinkContained(runtimeRootReal, stagingDir) ||
                    !isNonSymlinkContained(runtimeRootReal, stagingManifestPath)
                  ) {
                    return {
                      ok: false as const,
                      reason: "Hook runtime staging directory failed non-symlink containment check",
                    }
                  }
                  return { ok: true as const, emittedJsRels, manifest }
                },
                catch: toErrMessage,
              }).pipe(Result.flatMap((r) => (r.ok ? Result.succeed(r) : Result.fail(r.reason)))),
            ),
            Result.flatMap((stageMeta) =>
              withHookRuntimeBuildLock(runtimeRootReal, () =>
                swapStagedDirectoryAtomic(runtimeRootReal, stagingDir),
              ).pipe(
                Result.map((currentDir) => ({
                  _tag: "Built" as const,
                  snapshotDir: currentDir,
                  manifestPath: join(currentDir, "manifest.json"),
                  fileCount: stageMeta.emittedJsRels.size,
                  manifest: stageMeta.manifest,
                })),
              ),
            ),
          )

          return match(buildRes)
            .with({ _tag: "Success" }, ({ success }) => success)
            .with({ _tag: "Failure" }, ({ failure }) => {
              cleanupStaging()
              return { _tag: "Failed" as const, reason: failure }
            })
            .exhaustive()
        })
        .exhaustive()
    })
    .exhaustive()
}

const isSafeRelativeSnapshotTarget = (currentReal: string, relTarget: string): boolean => {
  if (isAbsolute(relTarget) || relTarget.includes("\\") || relTarget.trim().length === 0) {
    return false
  }
  const absTarget = resolve(currentReal, relTarget)
  if (!isInsideRoot(currentReal, absTarget)) return false
  return isNonSymlinkContained(currentReal, absTarget) && nodeSyncHostIo.isFileSync(absTarget)
}

const loadHookRuntimeSync = (
  repoRoot: string,
  options?: LoadHookRuntimeOptions,
): HookRuntimeLoadResult => {
  if (process.env["HARNESS_HOOK_RUNTIME_SOURCE"] === "1" || options?.forceSource === true) {
    return { _tag: "SourceFallback" as const, reason: "force-source-override" }
  }

  const repoRealRes = Result.try(() => nodeSyncHostIo.realpathSync(resolve(repoRoot)))
  const repoReal = match(repoRealRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (repoReal === undefined) {
    return { _tag: "SourceFallback" as const, reason: "missing-repo-root" }
  }

  const harnessDir = join(repoReal, ".harness")
  const runtimeDir = join(harnessDir, "hook-runtime")
  const currentDir = join(runtimeDir, "current")
  const manifestPath = join(currentDir, "manifest.json")

  if (
    !isNonSymlinkContained(repoReal, harnessDir) ||
    !isNonSymlinkContained(repoReal, runtimeDir) ||
    !isNonSymlinkContained(repoReal, currentDir) ||
    !isNonSymlinkContained(repoReal, manifestPath)
  ) {
    return { _tag: "SourceFallback" as const, reason: "snapshot-absent-or-unsafe" }
  }

  const currentRealRes = Result.try(() => nodeSyncHostIo.realpathSync(currentDir))
  const currentReal = match(currentRealRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (currentReal === undefined || !isInsideRoot(repoReal, currentReal)) {
    return { _tag: "SourceFallback" as const, reason: "snapshot-absent-or-unsafe" }
  }
  const rawManifestRes = Result.try(() => nodeSyncHostIo.readTextSync(manifestPath))
  const rawManifest = match(rawManifestRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (rawManifest === undefined) {
    return { _tag: "SourceFallback" as const, reason: "manifest-unreadable" }
  }

  return match(decodeManifest(rawManifest))
    .with({ _tag: "None" }, () => ({
      _tag: "SourceFallback" as const,
      reason: "manifest-corrupt",
    }))
    .with({ _tag: "Some" }, ({ value: manifest }) => {
      const verifyTargetHashed = (relTarget: string): boolean => {
        if (!isSafeRelativeSnapshotTarget(currentReal, relTarget)) return false
        const expectedHash = Object.hasOwn(manifest.fileHashes, relTarget)
          ? manifest.fileHashes[relTarget]
          : undefined
        return expectedHash !== undefined
      }
      if (!verifyTargetHashed(manifest.entryRel)) {
        return { _tag: "SourceFallback" as const, reason: "missing-entrypoint" }
      }
      for (const reqRel of REQUIRED_ENTRYPOINT_RELS) {
        if (!verifyTargetHashed(reqRel)) {
          return { _tag: "SourceFallback" as const, reason: `missing-required:${reqRel}` }
        }
      }
      for (const [spec, relTarget] of Object.entries(manifest.packageMap)) {
        if (!verifyTargetHashed(relTarget)) {
          return { _tag: "SourceFallback" as const, reason: `invalid-package-target:${spec}` }
        }
      }
      for (const [relPath, expectedHash] of Object.entries(manifest.fileHashes)) {
        if (!isSafeRelativeSnapshotTarget(currentReal, relPath)) {
          return { _tag: "SourceFallback" as const, reason: `unsafe-hashed-file:${relPath}` }
        }
        const hashMatchRes = Result.try(() => {
          const actual = createHash("sha256")
            .update(nodeSyncHostIo.readBytesSync(resolve(currentReal, relPath)))
            .digest("hex")
          return actual === expectedHash
        })
        const ok = match(hashMatchRes)
          .with({ _tag: "Success" }, ({ success }) => success)
          .with({ _tag: "Failure" }, () => false)
          .exhaustive()
        if (!ok) {
          return { _tag: "SourceFallback" as const, reason: `integrity-mismatch:${relPath}` }
        }
      }
      return {
        _tag: "Snapshot" as const,
        snapshotDir: currentReal,
        entryPath: join(currentReal, manifest.entryRel),
        packageMap: manifest.packageMap,
      }
    })
    .exhaustive()
}

/**
 * Validates and resolves the prebuilt `.harness/hook-runtime/current` snapshot, falling back
 * cleanly to live `.ts` resolution when absent, corrupt, or overridden (`SPEC-0037 REQ-4.3`).
 */
export const loadHookRuntime = Effect.fn("HarnessHookRuntime.load")(function* (
  repoRoot: string,
  options?: LoadHookRuntimeOptions,
): Effect.fn.Return<HookRuntimeLoadResult> {
  return yield* Effect.sync(() => loadHookRuntimeSync(repoRoot, options))
})

export const HarnessHookRuntime = {
  load: loadHookRuntime,
  buildSnapshot: buildHookRuntimeSnapshot,
} as const
