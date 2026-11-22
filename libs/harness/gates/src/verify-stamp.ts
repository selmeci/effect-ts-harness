import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { WorkspaceTreeHash } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { DstSeed } from "./dst-engine.js"
import {
  isWorkspaceRelPathIncludedInStamp,
  resolveHarnessStateDir,
  shouldIgnoreStampEntry,
} from "./worktree.js"

export { isWorkspaceRelPathIncludedInStamp, shouldIgnoreStampEntry }

export const DstSeedsRunCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("DstSeedsRunCount"),
)
export type DstSeedsRunCount = typeof DstSeedsRunCount.Type

export const StampIsoTimestamp = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("StampIsoTimestamp"),
)
export type StampIsoTimestamp = typeof StampIsoTimestamp.Type

export const StampBranchName = Schema.NonEmptyString.pipe(Schema.brand("StampBranchName"))
export type StampBranchName = typeof StampBranchName.Type

export const StampRelFilePath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("StampRelFilePath"),
)
export type StampRelFilePath = typeof StampRelFilePath.Type

export const MutantCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("MutantCount"),
)
export type MutantCount = typeof MutantCount.Type

export const MutateStampPassed = Schema.Boolean.pipe(Schema.brand("MutateStampPassed"))
export type MutateStampPassed = typeof MutateStampPassed.Type

export const MutateEnforcementMode = Schema.Literals(["strict", "advisory"])
export type MutateEnforcementMode = typeof MutateEnforcementMode.Type

export const MutateDiffMode = Schema.Literals([
  "all-lines",
  "explicit-files",
  "working-tree",
  "branch-base",
  "not-git",
])
export type MutateDiffMode = typeof MutateDiffMode.Type

export const MutateStampSchema = Schema.Struct({
  treeHash: WorkspaceTreeHash,
  timestamp: StampIsoTimestamp,
  enforcementMode: MutateEnforcementMode,
  diffMode: MutateDiffMode,
  scannedCandidateFiles: MutantCount,
  scannedFiles: Schema.Array(StampRelFilePath),
  diffMatchedFiles: Schema.Array(StampRelFilePath),
  evaluatedFiles: Schema.Array(StampRelFilePath),
  totalMutants: MutantCount,
  killedCount: MutantCount,
  equivalentCount: MutantCount,
  survivedCount: MutantCount,
  passed: MutateStampPassed,
})
export type MutateStamp = typeof MutateStampSchema.Type

export type CheckMutateStampResult =
  | { readonly _tag: "Valid"; readonly stamp: MutateStamp }
  | { readonly _tag: "Invalid"; readonly reason: string }

export const VerifyStampSchema = Schema.Struct({
  treeHash: WorkspaceTreeHash,
  mutableTreeHash: Schema.optional(WorkspaceTreeHash),
  timestamp: StampIsoTimestamp,
  taskBranch: StampBranchName,
  dstSeed: Schema.optional(DstSeed),
  dstSeedsRun: Schema.optional(DstSeedsRunCount),
  mutateEnforcementMode: Schema.optional(MutateEnforcementMode),
  mutantsEvaluated: Schema.optional(MutantCount),
})

export type VerifyStamp = Schema.Schema.Type<typeof VerifyStampSchema>

export type CheckVerifyStampResult =
  | { readonly valid: true; readonly stamp: VerifyStamp }
  | { readonly valid: false; readonly reason: string }

const formatErr = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const isContainedIn = (canonicalParent: string, canonicalTarget: string): boolean =>
  canonicalTarget === canonicalParent || canonicalTarget.startsWith(`${canonicalParent}/`)

const resolveHarnessDirChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
): Result.Result<string, string> =>
  Result.try({
    try: () => resolveHarnessStateDir(repoRoot, hostIo.getEnv()),
    catch: (err) => `Failed to resolve harness state directory: ${formatErr(err)}`,
  })

const checkSafeExistingDir = (
  dirPath: string,
  hostIo: SyncHostIo,
): Result.Result<string | undefined, string> => {
  const existsRes = Result.try({
    try: () => hostIo.existsSync(dirPath),
    catch: (err) => `Failed to stat '${dirPath}': ${formatErr(err)}`,
  })
  return Result.flatMap(existsRes, (exists) => {
    if (!exists) return Result.succeed(undefined)
    const symRes = Result.try({
      try: () => hostIo.isSymbolicLinkSync(dirPath),
      catch: (err) => `Failed to check symlink '${dirPath}': ${formatErr(err)}`,
    })
    return Result.flatMap(symRes, (isSymlink) => {
      if (isSymlink) return Result.fail(`Refusing symlink directory '${dirPath}'`)
      const dirRes = Result.try({
        try: () => hostIo.isDirectorySync(dirPath),
        catch: (err) => `Failed to check directory '${dirPath}': ${formatErr(err)}`,
      })
      return Result.flatMap(dirRes, (isDir) => {
        if (!isDir) return Result.fail(`Expected directory at '${dirPath}'`)
        return Result.try({
          try: () => hostIo.realpathSync(dirPath),
          catch: (err) => `Failed to resolve realpath for '${dirPath}': ${formatErr(err)}`,
        })
      })
    })
  })
}

const checkSafeStampFileForRead = (
  harnessDir: string,
  stampPath: string,
  hostIo: SyncHostIo,
  missingMessage: string,
): Result.Result<string, string> =>
  Result.flatMap(checkSafeExistingDir(harnessDir, hostIo), (canonicalHarnessDir) => {
    if (canonicalHarnessDir === undefined) return Result.fail(missingMessage)
    const symRes = Result.try({
      try: () => hostIo.isSymbolicLinkSync(stampPath),
      catch: (err) => `Failed to check symlink '${stampPath}': ${formatErr(err)}`,
    })
    return Result.flatMap(symRes, (isSymlink) => {
      if (isSymlink) return Result.fail(`Refusing symlink stamp '${stampPath}'`)
      const existsRes = Result.try({
        try: () => hostIo.existsSync(stampPath),
        catch: (err) => `Failed to stat '${stampPath}': ${formatErr(err)}`,
      })
      return Result.flatMap(existsRes, (exists) => {
        if (!exists) return Result.fail(missingMessage)
        const realRes = Result.try({
          try: () => hostIo.realpathSync(stampPath),
          catch: (err) => `Failed to resolve realpath for '${stampPath}': ${formatErr(err)}`,
        })
        return Result.flatMap(realRes, (canonicalStamp) => {
          if (!isContainedIn(canonicalHarnessDir, canonicalStamp)) {
            return Result.fail(
              `Stamp '${stampPath}' resolves outside harness directory '${canonicalHarnessDir}'`,
            )
          }
          return Result.try({
            try: () => hostIo.readTextSync(stampPath),
            catch: (err) => `Failed to read '${stampPath}': ${formatErr(err)}`,
          })
        })
      })
    })
  })

const cleanupTempStamp = (tmpPath: string, hostIo: SyncHostIo): string | undefined =>
  match(
    Result.try({
      try: () => {
        if (hostIo.existsSync(tmpPath)) hostIo.unlinkSync(tmpPath)
      },
      catch: (err) => formatErr(err),
    }),
  )
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => failure)
    .exhaustive()

const writeStampAtomic = (
  harnessDir: string,
  stampPath: string,
  content: string,
  hostIo: SyncHostIo,
): Result.Result<void, string> =>
  Result.flatMap(checkSafeExistingDir(harnessDir, hostIo), (existingReal) => {
    const ensureDirRes =
      existingReal !== undefined
        ? Result.succeed(existingReal)
        : Result.try({
            try: () => {
              hostIo.mkdirRecursiveSync(harnessDir)
              return hostIo.realpathSync(harnessDir)
            },
            catch: (err) => `Failed to create '${harnessDir}': ${formatErr(err)}`,
          })
    return Result.flatMap(ensureDirRes, (canonicalHarnessDir) => {
      const symRes = Result.try({
        try: () => hostIo.isSymbolicLinkSync(stampPath),
        catch: (err) => `Failed to check symlink '${stampPath}': ${formatErr(err)}`,
      })
      return Result.flatMap(symRes, (isSymlink) => {
        if (isSymlink) return Result.fail(`Refusing to overwrite symlink '${stampPath}'`)
        const tmpPath = `${stampPath}.tmp-${process.pid}`
        const tmpSymRes = Result.try({
          try: () => hostIo.isSymbolicLinkSync(tmpPath),
          catch: (err) => `Failed to check temp symlink '${tmpPath}': ${formatErr(err)}`,
        })
        return Result.flatMap(tmpSymRes, (tmpIsSymlink) => {
          if (tmpIsSymlink) return Result.fail(`Refusing symlink temp file '${tmpPath}'`)
          return Result.flatMap(
            Result.try({
              try: () => {
                hostIo.writeTextSync(tmpPath, content)
                return hostIo.realpathSync(tmpPath)
              },
              catch: (err) => {
                const cleanupErr = cleanupTempStamp(tmpPath, hostIo)
                const suffix = cleanupErr !== undefined ? ` (cleanup failed: ${cleanupErr})` : ""
                return `Failed to write '${stampPath}': ${formatErr(err)}${suffix}`
              },
            }),
            (tmpReal) => {
              if (!isContainedIn(canonicalHarnessDir, tmpReal)) {
                const cleanupErr = cleanupTempStamp(tmpPath, hostIo)
                const suffix = cleanupErr !== undefined ? ` (cleanup failed: ${cleanupErr})` : ""
                return Result.fail(
                  `Temp stamp '${tmpPath}' escaped '${canonicalHarnessDir}'${suffix}`,
                )
              }
              return Result.try({
                try: () => hostIo.renameSync(tmpPath, stampPath),
                catch: (err) => {
                  const cleanupErr = cleanupTempStamp(tmpPath, hostIo)
                  const suffix = cleanupErr !== undefined ? ` (cleanup failed: ${cleanupErr})` : ""
                  return `Failed to write '${stampPath}': ${formatErr(err)}${suffix}`
                },
              })
            },
          )
        })
      })
    })
  })

const shouldIgnoreEntry = (dir: string, baseDir: string, name: string): boolean => {
  const relDir = relative(baseDir, dir).replace(/\\/g, "/")
  return shouldIgnoreStampEntry(dir === baseDir, relDir, name)
}

const collectFilesChecked = (
  dir: string,
  baseDir: string,
  canonicalRoot: string,
  acc: Array<string>,
  harnessStateDir: string,
  hostIo: SyncHostIo,
): Result.Result<void, string> => {
  const safeDirRes = checkSafeExistingDir(dir, hostIo)
  return Result.flatMap(safeDirRes, (canonicalDir) => {
    if (canonicalDir === undefined) return Result.succeed(undefined)
    if (!isContainedIn(canonicalRoot, canonicalDir)) {
      return Result.fail(`Refusing directory outside repoRoot: '${dir}'`)
    }
    const entriesRes = Result.try({
      try: () => hostIo.readdirSync(dir),
      catch: (err) => `Failed to read directory '${dir}': ${formatErr(err)}`,
    })
    return Result.flatMap(entriesRes, (entries) => {
      for (const entry of entries) {
        if (shouldIgnoreEntry(dir, baseDir, entry.name)) continue
        const fullPath = join(dir, entry.name)
        if (fullPath === harnessStateDir || fullPath.startsWith(`${harnessStateDir}/`)) continue

        const symRes = Result.try({
          try: () => hostIo.isSymbolicLinkSync(fullPath),
          catch: (err) => `Failed to check symlink '${fullPath}': ${formatErr(err)}`,
        })
        const symErr = match(symRes)
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .with({ _tag: "Success" }, ({ success: isSymlink }) =>
            isSymlink
              ? `Refusing to hash symbolic link '${relative(baseDir, fullPath).replace(/\\/g, "/")}'`
              : undefined,
          )
          .exhaustive()
        if (symErr !== undefined) return Result.fail(symErr)

        const stepRes = match({ isDirectory: entry.isDirectory, isFile: entry.isFile })
          .with({ isDirectory: true }, () =>
            collectFilesChecked(fullPath, baseDir, canonicalRoot, acc, harnessStateDir, hostIo),
          )
          .with({ isDirectory: false, isFile: true }, () => {
            acc.push(relative(baseDir, fullPath).replace(/\\/g, "/"))
            return Result.succeed(undefined)
          })
          .with({ isDirectory: false, isFile: false }, () => Result.succeed(undefined))
          .exhaustive()
        const stepErr = match(stepRes)
          .with({ _tag: "Success" }, () => undefined)
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .exhaustive()
        if (stepErr !== undefined) return Result.fail(stepErr)
      }
      return Result.succeed(undefined)
    })
  })
}

const NON_DOC_MARKDOWN_DIR_RE =
  /(?:^|\/)(?:adapters|agent-patterns|src|test|tests|__tests__|fixtures)\//i

/**
 * Returns true iff a repo-relative path is a non-executable markdown documentation file
 * outside `adapters/`, `agent-patterns/`, source directories, and test/fixture directories
 * excluded from mutable code stamps (`mutate-stamp.json`).
 */
export const isMarkdownDocPath = (relPath: string): boolean => {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "")
  return /\.(?:md|mdx)$/i.test(norm) && !NON_DOC_MARKDOWN_DIR_RE.test(norm)
}

const computeFilteredWorkspaceTreeHashChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
  includeFile?: (relPath: string) => boolean,
): Result.Result<WorkspaceTreeHash, string> =>
  Result.flatMap(resolveHarnessDirChecked(repoRoot, hostIo), (harnessStateDir) =>
    Result.flatMap(checkSafeExistingDir(repoRoot, hostIo), (canonicalRoot) => {
      if (canonicalRoot === undefined) {
        return Result.fail(`Workspace root '${repoRoot}' does not exist`)
      }
      const rawFiles: Array<string> = []
      return Result.flatMap(
        collectFilesChecked(repoRoot, repoRoot, canonicalRoot, rawFiles, harnessStateDir, hostIo),
        () => {
          const files = includeFile !== undefined ? rawFiles.filter(includeFile) : rawFiles
          files.sort()
          const hasher = createHash("sha256")
          for (const rel of files) {
            const fullPath = join(repoRoot, rel)
            const readRes = Result.flatMap(
              Result.try({
                try: () => hostIo.isSymbolicLinkSync(fullPath),
                catch: (err) =>
                  `Failed to read workspace file '${rel}' while computing tree hash: ${formatErr(err)}`,
              }),
              (isSym) => {
                if (isSym) {
                  return Result.fail(
                    `Failed to read workspace file '${rel}' while computing tree hash: Refusing to hash symbolic link '${rel}'`,
                  )
                }
                return Result.flatMap(
                  Result.try({
                    try: () => hostIo.realpathSync(fullPath),
                    catch: (err) =>
                      `Failed to read workspace file '${rel}' while computing tree hash: ${formatErr(err)}`,
                  }),
                  (canonicalFile) => {
                    if (!isContainedIn(canonicalRoot, canonicalFile)) {
                      return Result.fail(
                        `Failed to read workspace file '${rel}' while computing tree hash: File '${rel}' resolves outside workspace root`,
                      )
                    }
                    return Result.try({
                      try: () => hostIo.readBytesSync(fullPath),
                      catch: (err) =>
                        `Failed to read workspace file '${rel}' while computing tree hash: ${formatErr(err)}`,
                    })
                  },
                )
              },
            )
            const readErr = match(readRes)
              .with({ _tag: "Failure" }, ({ failure }) => failure)
              .with({ _tag: "Success" }, ({ success: content }) => {
                hasher.update(`${Buffer.byteLength(rel)}\0${rel}\0${content.byteLength}\0`)
                hasher.update(content)
                return undefined
              })
              .exhaustive()
            if (readErr !== undefined) return Result.fail(readErr)
          }
          return Result.succeed(WorkspaceTreeHash.make(hasher.digest("hex")))
        },
      )
    }),
  )

export const computeWorkspaceTreeHashChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
): Result.Result<WorkspaceTreeHash, string> =>
  computeFilteredWorkspaceTreeHashChecked(repoRoot, hostIo)

export const computeWorkspaceTreeHash = (repoRoot: string, hostIo: SyncHostIo): WorkspaceTreeHash =>
  Result.getOrThrowWith(computeWorkspaceTreeHashChecked(repoRoot, hostIo), (err) => new Error(err))

export const computeMutableTreeHashChecked = (
  repoRoot: string,
  hostIo: SyncHostIo,
): Result.Result<WorkspaceTreeHash, string> =>
  computeFilteredWorkspaceTreeHashChecked(repoRoot, hostIo, (rel) => !isMarkdownDocPath(rel))

export const computeMutableTreeHash = (repoRoot: string, hostIo: SyncHostIo): WorkspaceTreeHash =>
  Result.getOrThrowWith(computeMutableTreeHashChecked(repoRoot, hostIo), (err) => new Error(err))

const decodeDstSeedSync = Schema.decodeUnknownSync(DstSeed)

export const parseDstSeedEnv = (raw: string | undefined): DstSeed | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const numericValue = Number(trimmed)
  const candidate: unknown =
    /^\d+$/.test(trimmed) && Number.isSafeInteger(numericValue) ? numericValue : raw
  return Result.getOrThrowWith(
    Result.try(() => decodeDstSeedSync(candidate)),
    (failure) => new Error(`Invalid DST_SEED value "${raw}": ${formatErr(failure)}`),
  )
}

export const writeVerifyStamp = (
  repoRoot: string,
  hostIo: SyncHostIo,
  taskBranch?: string,
  dstOptions?: {
    readonly dstSeed?: DstSeed | undefined
    readonly dstSeedsRun?: number | undefined
  },
  mutateMeta?: {
    readonly mutateEnforcementMode?: MutateEnforcementMode | undefined
    readonly mutantsEvaluated?: MutantCount | undefined
  },
): VerifyStamp => {
  const treeHash = computeWorkspaceTreeHash(repoRoot, hostIo)
  const mutableTreeHash = computeMutableTreeHash(repoRoot, hostIo)
  const env = hostIo.getEnv()
  const envSeed = parseDstSeedEnv(env["DST_SEED"])
  const resolvedSeed = dstOptions?.dstSeed ?? envSeed ?? DstSeed.make(0)
  const resolvedBranch =
    taskBranch !== undefined && taskBranch.trim().length > 0 ? taskBranch : "unknown"
  const stamp: VerifyStamp = {
    treeHash,
    mutableTreeHash,
    timestamp: StampIsoTimestamp.make(new Date().toISOString()),
    taskBranch: StampBranchName.make(resolvedBranch),
    dstSeed: resolvedSeed,
    ...(dstOptions?.dstSeedsRun !== undefined
      ? { dstSeedsRun: DstSeedsRunCount.make(Math.max(0, Math.trunc(dstOptions.dstSeedsRun))) }
      : {}),
    ...(mutateMeta?.mutateEnforcementMode !== undefined
      ? { mutateEnforcementMode: mutateMeta.mutateEnforcementMode }
      : {}),
    ...(mutateMeta?.mutantsEvaluated !== undefined
      ? { mutantsEvaluated: mutateMeta.mutantsEvaluated }
      : {}),
  }
  const harnessDir = Result.getOrThrowWith(
    resolveHarnessDirChecked(repoRoot, hostIo),
    (err) => new Error(err),
  )
  const stampPath = join(harnessDir, "verify-stamp.json")
  Result.getOrThrowWith(
    writeStampAtomic(harnessDir, stampPath, JSON.stringify(stamp, null, 2) + "\n", hostIo),
    (err) => new Error(err),
  )
  return stamp
}

const decodeVerifyStamp = Schema.decodeOption(Schema.fromJsonString(VerifyStampSchema))

/**
 * Safely reads and schema-decodes `.harness/verify-stamp.json` without checking `treeHash`.
 * Returns `undefined` when missing, symlinked, outside harness state dir, or malformed.
 */
export const readExistingVerifyStamp = (
  repoRoot: string,
  hostIo: SyncHostIo,
): VerifyStamp | undefined => {
  const contentRes = Result.flatMap(resolveHarnessDirChecked(repoRoot, hostIo), (harnessDir) =>
    checkSafeStampFileForRead(
      harnessDir,
      join(harnessDir, "verify-stamp.json"),
      hostIo,
      "Missing .harness/verify-stamp.json.",
    ),
  )
  return match(contentRes)
    .with({ _tag: "Failure" }, () => undefined)
    .with({ _tag: "Success" }, ({ success: content }) =>
      match(decodeVerifyStamp(content))
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive(),
    )
    .exhaustive()
}

export const checkVerifyStamp = (repoRoot: string, hostIo: SyncHostIo): CheckVerifyStampResult => {
  const missingMsg =
    "Missing .harness/verify-stamp.json. Run harness verify after your latest edits before finishing."
  const contentRes = Result.flatMap(resolveHarnessDirChecked(repoRoot, hostIo), (harnessDir) =>
    checkSafeStampFileForRead(
      harnessDir,
      join(harnessDir, "verify-stamp.json"),
      hostIo,
      missingMsg,
    ),
  )
  return match(contentRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({ valid: false as const, reason: failure }))
    .with({ _tag: "Success" }, ({ success: content }) =>
      match(decodeVerifyStamp(content))
        .with({ _tag: "None" }, () => ({
          valid: false as const,
          reason:
            "Invalid .harness/verify-stamp.json. Run harness verify after your latest edits before finishing.",
        }))
        .with({ _tag: "Some" }, ({ value: stamp }) =>
          match(computeWorkspaceTreeHashChecked(repoRoot, hostIo))
            .with({ _tag: "Failure" }, ({ failure }) => ({
              valid: false as const,
              reason: `Failed to compute workspace tree hash (${failure}). Run harness verify after your latest edits before finishing.`,
            }))
            .with({ _tag: "Success" }, ({ success: currentTreeHash }) =>
              stamp.treeHash !== currentTreeHash
                ? {
                    valid: false as const,
                    reason:
                      "Workspace files changed since last verify. Run harness verify after your latest edits before finishing.",
                  }
                : { valid: true as const, stamp },
            )
            .exhaustive(),
        )
        .exhaustive(),
    )
    .exhaustive()
}

export const writeMutateStamp = (
  repoRoot: string,
  hostIo: SyncHostIo,
  input: Omit<MutateStamp, "treeHash" | "timestamp">,
): MutateStamp => {
  const treeHash = computeMutableTreeHash(repoRoot, hostIo)
  const stamp: MutateStamp = {
    treeHash,
    timestamp: StampIsoTimestamp.make(new Date().toISOString()),
    ...input,
  }
  const harnessDir = Result.getOrThrowWith(
    resolveHarnessDirChecked(repoRoot, hostIo),
    (err) => new Error(err),
  )
  const stampPath = join(harnessDir, "mutate-stamp.json")
  Result.getOrThrowWith(
    writeStampAtomic(harnessDir, stampPath, JSON.stringify(stamp, null, 2) + "\n", hostIo),
    (err) => new Error(err),
  )
  return stamp
}

const isEnoentError = (err: unknown): boolean =>
  (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") ||
  /\bENOENT\b/.test(formatErr(err))

export const removeMutateStamp = (
  repoRoot: string,
  hostIo: SyncHostIo,
): Result.Result<void, string> =>
  Result.flatMap(resolveHarnessDirChecked(repoRoot, hostIo), (harnessDir) => {
    const stampPath = join(harnessDir, "mutate-stamp.json")
    return Result.flatMap(checkSafeExistingDir(harnessDir, hostIo), (canonicalHarnessDir) => {
      if (canonicalHarnessDir === undefined) return Result.succeed(undefined)
      const preCheckRes = Result.try({
        try: () => {
          const isSym = hostIo.isSymbolicLinkSync(stampPath)
          const exists = hostIo.existsSync(stampPath)
          return { isSym, exists }
        },
        catch: (err) => err,
      })
      const unlinkRes = Result.flatMap(preCheckRes, ({ isSym, exists }) => {
        if (!isSym && !exists) return Result.succeed(undefined)
        if (!isSym) {
          const realRes = Result.try({
            try: () => hostIo.realpathSync(stampPath),
            catch: (err) => err,
          })
          const realErr = match(realRes)
            .with({ _tag: "Failure" }, ({ failure }) => failure)
            .with({ _tag: "Success" }, ({ success: realStamp }) =>
              !isContainedIn(canonicalHarnessDir, realStamp)
                ? new Error(`Refusing to unlink stamp outside '${canonicalHarnessDir}'`)
                : undefined,
            )
            .exhaustive()
          if (realErr !== undefined) return Result.fail(realErr)
        }
        return Result.try({
          try: () => hostIo.unlinkSync(stampPath),
          catch: (err) => err,
        })
      })
      return match(unlinkRes)
        .with({ _tag: "Success" }, () => Result.succeed(undefined))
        .with({ _tag: "Failure" }, ({ failure: err }) =>
          isEnoentError(err)
            ? Result.succeed(undefined)
            : Result.fail(`Failed to remove '${stampPath}': ${formatErr(err)}`),
        )
        .exhaustive()
    })
  })

const decodeMutateStamp = Schema.decodeOption(Schema.fromJsonString(MutateStampSchema))

const checkRequiredDiffCoverage = (
  stamp: MutateStamp,
  requiredDiffFiles: ReadonlyArray<string>,
): string | undefined => {
  if (requiredDiffFiles.length === 0) return undefined
  const coveredSet = match(stamp.diffMode)
    .with(
      "all-lines",
      () =>
        new Set<string>([
          ...stamp.scannedFiles,
          ...stamp.evaluatedFiles,
          ...stamp.diffMatchedFiles,
        ]),
    )
    .with("working-tree", "branch-base", () => new Set<string>(stamp.diffMatchedFiles))
    .with(
      "explicit-files",
      () => new Set<string>([...stamp.diffMatchedFiles, ...stamp.evaluatedFiles]),
    )
    .with("not-git", () => undefined)
    .exhaustive()

  if (coveredSet === undefined) {
    return "Mutate stamp diffMode 'not-git' cannot satisfy required diff file coverage. Run pnpm harness mutate --strict."
  }
  const missing = requiredDiffFiles.filter((file) => !coveredSet.has(file))
  if (missing.length > 0) {
    return `Mutate stamp does not cover required diff file(s): ${missing.join(", ")}. Run pnpm harness mutate --strict.`
  }
  return undefined
}

export const checkMutateStamp = (
  repoRoot: string,
  hostIo: SyncHostIo,
  requiredDiffFiles?: ReadonlyArray<string>,
): CheckMutateStampResult => {
  const missingMsg =
    "Missing .harness/mutate-stamp.json. Run pnpm harness mutate --strict after your latest edits before verify."
  const contentRes = Result.flatMap(resolveHarnessDirChecked(repoRoot, hostIo), (harnessDir) =>
    checkSafeStampFileForRead(
      harnessDir,
      join(harnessDir, "mutate-stamp.json"),
      hostIo,
      missingMsg,
    ),
  )
  return match(contentRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({ _tag: "Invalid" as const, reason: failure }))
    .with({ _tag: "Success" }, ({ success: content }) =>
      match(decodeMutateStamp(content))
        .with({ _tag: "None" }, () => ({
          _tag: "Invalid" as const,
          reason:
            "Invalid .harness/mutate-stamp.json. Run pnpm harness mutate --strict after your latest edits before verify.",
        }))
        .with({ _tag: "Some" }, ({ value: stamp }) =>
          match(stamp.enforcementMode)
            .with("advisory", () => ({
              _tag: "Invalid" as const,
              reason:
                "Advisory .harness/mutate-stamp.json is insufficient for verify. Run pnpm harness mutate --strict after your latest edits before verify.",
            }))
            .with("strict", () => {
              if (
                stamp.totalMutants < 1 ||
                stamp.survivedCount > 0 ||
                stamp.killedCount + stamp.equivalentCount !== stamp.totalMutants ||
                !stamp.passed
              ) {
                return {
                  _tag: "Invalid" as const,
                  reason:
                    "Mutate stamp did not record a clean passing strict run (requires totalMutants >= 1, survivedCount === 0, killedCount + equivalentCount === totalMutants, passed === true). Run pnpm harness mutate --strict.",
                }
              }
              const coverageErr =
                requiredDiffFiles !== undefined
                  ? checkRequiredDiffCoverage(stamp, requiredDiffFiles)
                  : undefined
              if (coverageErr !== undefined) {
                return { _tag: "Invalid" as const, reason: coverageErr }
              }
              return match(computeMutableTreeHashChecked(repoRoot, hostIo))
                .with({ _tag: "Failure" }, ({ failure }) => ({
                  _tag: "Invalid" as const,
                  reason: `Failed to compute mutable workspace tree hash (${failure}). Run pnpm harness mutate --strict after your latest edits before verify.`,
                }))
                .with({ _tag: "Success" }, ({ success: currentTreeHash }) =>
                  stamp.treeHash !== currentTreeHash
                    ? {
                        _tag: "Invalid" as const,
                        reason:
                          "Workspace files changed since last mutate --strict. Run pnpm harness mutate --strict after your latest edits before verify.",
                      }
                    : { _tag: "Valid" as const, stamp },
                )
                .exhaustive()
            })
            .exhaustive(),
        )
        .exhaustive(),
    )
    .exhaustive()
}
