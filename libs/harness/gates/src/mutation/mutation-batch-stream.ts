/**
 * @fileoverview Streamed NDJSON package-batch recovery, plan serialization, and duration helpers (`REQ-1.5`, `REQ-3.2`, `REQ-4.1`).
 */
import { randomBytes } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AstSourceFilePath,
  MUTATION_HEAVY_TEST_THRESHOLD_MS,
  computeContentSha256,
} from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { needsSoloColdRecheck } from "../mutation-subprocess-helpers.js"
import type { CodeMutant, MutantOutcome } from "./mutant-ast-generator.js"
import { isPathContained, isUnsafeSymlinkPath, realpathOrUndefined } from "./mutation-cache.js"
import type { DomainFile } from "./mutation-target-discovery.js"
import { type PackageBatchFileOutput, PackageBatchFileOutputSchema } from "./mutation-witness.js"

export { PackageBatchFileOutputSchema, type PackageBatchFileOutput, needsSoloColdRecheck }

export interface PackageBatchFileInput {
  readonly file: DomainFile
  readonly originalContent: string
  readonly schemaSource: string
  readonly mutants: ReadonlyArray<CodeMutant>
  readonly uncachedMutants: ReadonlyArray<CodeMutant>
  readonly primaryTests: ReadonlyArray<string>
  readonly scopedFallbackTests: ReadonlyArray<string>
  readonly packageFallbackTests: ReadonlyArray<string>
  readonly fallbackTests: ReadonlyArray<string>
  readonly cachedHitIds: ReadonlySet<string>
}

const StreamedBatchReportLineSchema = Schema.fromJsonString(PackageBatchFileOutputSchema)

const existsSafe = (p: string, hostIo: SyncHostIo): boolean | undefined =>
  match(Result.try(() => hostIo.existsSync(p)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()

/** Validates non-symlink ancestors and `realpathSync` containment for batch plan/stream files. */
export const validateBatchArtifactPath = (
  repoRoot: string | undefined,
  targetFilePath: string,
  hostIo: SyncHostIo,
): string | undefined => {
  if (isUnsafeSymlinkPath(targetFilePath, hostIo)) {
    return `symlink or unsafe path '${targetFilePath}'`
  }
  const targetDir = resolve(dirname(targetFilePath))
  if (isUnsafeSymlinkPath(targetDir, hostIo)) {
    return `symlink or unsafe dir '${targetDir}'`
  }
  if (repoRoot === undefined) {
    const dirReal = realpathOrUndefined(targetDir, hostIo)
    if (dirReal !== undefined && existsSafe(targetFilePath, hostIo) === true) {
      const fileReal = realpathOrUndefined(targetFilePath, hostIo)
      if (fileReal === undefined || !isPathContained(dirReal, fileReal)) {
        return `realpath escape detected for '${targetFilePath}'`
      }
    }
    return undefined
  }
  const resolvedRoot = resolve(repoRoot)
  if (!isPathContained(resolvedRoot, targetDir)) {
    return `batch path '${targetFilePath}' escapes repoRoot '${repoRoot}'`
  }
  let cur = targetDir
  let deepestExisting: string | undefined = undefined
  while (true) {
    if (isUnsafeSymlinkPath(cur, hostIo)) {
      return `symlink or unsafe ancestor '${cur}'`
    }
    const ex = existsSafe(cur, hostIo)
    if (ex === undefined) return `failed to stat '${cur}'`
    if (ex && deepestExisting === undefined) deepestExisting = cur
    if (cur === resolvedRoot || cur === dirname(cur)) break
    cur = dirname(cur)
  }
  const repoReal = realpathOrUndefined(resolvedRoot, hostIo)
  if (repoReal === undefined) return `unreadable repoRoot '${repoRoot}'`
  if (deepestExisting !== undefined) {
    const deepReal = realpathOrUndefined(deepestExisting, hostIo)
    if (deepReal === undefined || !isPathContained(repoReal, deepReal)) {
      return `realpath escape detected for '${deepestExisting}'`
    }
  }
  if (existsSafe(targetFilePath, hostIo) === true) {
    const fileReal = realpathOrUndefined(targetFilePath, hostIo)
    if (fileReal === undefined || !isPathContained(repoReal, fileReal)) {
      return `realpath escape detected for '${targetFilePath}'`
    }
  }
  return undefined
}

/**
 * Reads completed per-file batch reports from an NDJSON stream file, cleanly ignoring any
 * trailing truncated/partial line when a worker crashed or timed out mid-write.
 */
export const readStreamedPackageBatchReports = (
  streamReportPath: string,
  hostIo: SyncHostIo,
  repoRoot?: string,
): ReadonlyArray<PackageBatchFileOutput> => {
  if (validateBatchArtifactPath(repoRoot, streamReportPath, hostIo) !== undefined) {
    return []
  }
  if (existsSafe(streamReportPath, hostIo) !== true) return []
  const raw = match(Result.try(() => hostIo.readTextSync(streamReportPath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      process.stderr.write(
        `[mutation-check] Warning: Failed to read streamed batch report '${streamReportPath}': ${failure instanceof Error ? failure.message : String(failure)}\n`,
      )
      return ""
    })
    .exhaustive()
  if (raw.length === 0) return []
  const nonEmptyLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const reports: Array<PackageBatchFileOutput> = []
  for (let i = 0; i < nonEmptyLines.length; i++) {
    const line = nonEmptyLines[i]!
    match(Schema.decodeExit(StreamedBatchReportLineSchema)(line))
      .with({ _tag: "Success" }, ({ value }) => {
        reports.push(value)
      })
      .with({ _tag: "Failure" }, () => {
        if (i < nonEmptyLines.length - 1) {
          process.stderr.write(
            `[mutation-check] Warning: Skipping malformed NDJSON batch line ${i + 1}/${nonEmptyLines.length} in '${streamReportPath}'.\n`,
          )
        }
      })
      .exhaustive()
  }
  return reports
}

/** Best-effort removal of a temporary batch plan or streamed NDJSON report file after safety checks. */
export const cleanupStreamReportFile = (
  streamReportPath: string,
  hostIo: SyncHostIo,
  repoRoot?: string,
): void => {
  if (validateBatchArtifactPath(repoRoot, streamReportPath, hostIo) !== undefined) return
  void Result.try(() => {
    if (hostIo.existsSync(streamReportPath)) hostIo.unlinkSync(streamReportPath)
  })
}

/** Merges finite non-negative observed test durations into `target`. */
export const mergeObservedDurationsIntoMap = (
  target: Map<string, number>,
  observed: Readonly<Record<string, number>> | ReadonlyMap<string, number> | undefined,
): void => {
  if (observed === undefined) return
  const pairs: Iterable<readonly [string, number]> =
    observed instanceof Map ? observed.entries() : Object.entries(observed)
  for (const [testPath, durationMs] of pairs) {
    if (
      testPath.length > 0 &&
      typeof durationMs === "number" &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
    ) {
      target.set(testPath, durationMs)
    }
  }
}

export const stageTimeoutMs = (tests: ReadonlyArray<string>): number =>
  Math.max(30_000, Math.min(180_000, Math.max(1, tests.length) * 10_000))

export const shouldRecordOutcome = (
  onlyUpdateOnKill: boolean,
  status: "killed" | "survived" | "equivalent",
): boolean =>
  !onlyUpdateOnKill ||
  match(status)
    .with("killed", () => true)
    .with("survived", "equivalent", () => false)
    .exhaustive()

export const recordStageOutcomes = (
  outcomes: ReadonlyArray<MutantOutcome>,
  nonCacheableIds: ReadonlySet<string>,
  stageWitnessByMutantId: ReadonlyMap<string, AstSourceFilePath>,
  fileOutcomes: Map<string, MutantOutcome>,
  fileNonCacheableIds: Set<string>,
  witnessByMutantId: Map<string, AstSourceFilePath>,
  onlyUpdateOnKill: boolean,
): void => {
  for (const id of nonCacheableIds) fileNonCacheableIds.add(id)
  for (const o of outcomes) {
    if (shouldRecordOutcome(onlyUpdateOnKill, o.status)) {
      fileOutcomes.set(o.mutant.id, o)
      match(o.status)
        .with("killed", () => {
          if (!fileNonCacheableIds.has(o.mutant.id)) {
            const w = stageWitnessByMutantId.get(o.mutant.id)
            if (w !== undefined) witnessByMutantId.set(o.mutant.id, w)
          }
        })
        .with("survived", "equivalent", () => {})
        .exhaustive()
    }
  }
}

export const collectSurvivingMutants = (
  mutants: ReadonlyArray<CodeMutant>,
  fileOutcomes: ReadonlyMap<string, MutantOutcome>,
): ReadonlyArray<CodeMutant> =>
  mutants.filter((m) =>
    match(fileOutcomes.get(m.id)?.status)
      .with("survived", () => true)
      .with("killed", "equivalent", undefined, () => false)
      .exhaustive(),
  )

/** Serializes and writes the package batch plan JSON plus temporary NDJSON stream path. */
export const writePackageBatchPlan = (input: {
  readonly repoRoot: string
  readonly backupPath: string
  readonly vitestCliPath: string
  readonly hostIo: SyncHostIo
  readonly allPackageTests: ReadonlyArray<string>
  readonly files: ReadonlyArray<PackageBatchFileInput>
  readonly measuredDurationsMs?: Readonly<Record<string, number>> | undefined
  readonly maxSurvivors?: number | undefined
  readonly maxWorkerRssBytes?: number | undefined
}):
  | {
      readonly _tag: "Ok"
      readonly planPath: string
      readonly streamReportPath: string
      readonly totalMutants: number
    }
  | { readonly _tag: "Err"; readonly diagnostic: string } => {
  let totalMutants = 0
  const planFiles = input.files.map((f) => {
    totalMutants += f.uncachedMutants.length
    return {
      relFile: f.file.relFile,
      fullPath: f.file.fullPath,
      originalSha256: computeContentSha256(f.originalContent),
      mutatedSha256: computeContentSha256(f.schemaSource),
      originalSource: f.originalContent,
      schemaSource: f.schemaSource,
      primaryTests: f.primaryTests,
      scopedFallbackTests: f.scopedFallbackTests,
      packageFallbackTests: f.packageFallbackTests,
      mutantIds: f.uncachedMutants.map((m) => m.id),
      primaryTimeoutMs: stageTimeoutMs(f.primaryTests),
      scopedFallbackTimeoutMs: stageTimeoutMs(f.scopedFallbackTests),
      packageFallbackTimeoutMs: stageTimeoutMs(f.packageFallbackTests),
    }
  })
  const runSuffix = `${process.pid}-${randomBytes(6).toString("hex")}`
  const planPath = join(dirname(input.backupPath), `pkg-plan-${runSuffix}.json`)
  const streamReportPath = join(dirname(input.backupPath), `pkg-stream-${runSuffix}.ndjson`)
  const preCheckErr =
    validateBatchArtifactPath(input.repoRoot, planPath, input.hostIo) ??
    validateBatchArtifactPath(input.repoRoot, streamReportPath, input.hostIo)
  if (preCheckErr !== undefined) {
    return {
      _tag: "Err" as const,
      diagnostic: `[mutation-check] Refusing unsafe package batch path '${planPath}': ${preCheckErr}`,
    }
  }
  const writePlanRes = Result.try({
    try: () => {
      input.hostIo.mkdirRecursiveSync(dirname(planPath))
      const postCheckErr =
        validateBatchArtifactPath(input.repoRoot, planPath, input.hostIo) ??
        validateBatchArtifactPath(input.repoRoot, streamReportPath, input.hostIo)
      if (postCheckErr !== undefined) {
        // oxlint-disable-next-line -- local Result.try boundary converts post-mkdir safety failure into Err diagnostic
        throw new Error(postCheckErr)
      }
      input.hostIo.writeTextSync(
        planPath,
        JSON.stringify({
          cwd: input.repoRoot,
          backupPath: input.backupPath,
          vitestCli: input.vitestCliPath,
          allPackageTests: input.allPackageTests,
          baselinedTests: Array.from(new Set(input.files.flatMap((f) => f.primaryTests))),
          streamReportPath,
          heavyThresholdMs: MUTATION_HEAVY_TEST_THRESHOLD_MS,
          ...(input.measuredDurationsMs !== undefined
            ? { testDurationsMs: input.measuredDurationsMs }
            : {}),
          ...(input.maxSurvivors !== undefined ? { maxSurvivors: input.maxSurvivors } : {}),
          ...(input.maxWorkerRssBytes !== undefined
            ? { maxWorkerRssBytes: input.maxWorkerRssBytes }
            : {}),
          files: planFiles,
        }),
      )
    },
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return match(writePlanRes)
    .with({ _tag: "Success" }, () => ({
      _tag: "Ok" as const,
      planPath,
      streamReportPath,
      totalMutants,
    }))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Err" as const,
      diagnostic: `[mutation-check] Failed to write package batch plan '${planPath}': ${failure}`,
    }))
    .exhaustive()
}
