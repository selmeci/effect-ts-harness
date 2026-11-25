/**
 * @fileoverview Witness test path normalization, Vitest failure attribution, and survivor formatting.
 */
import { isAbsolute, posix, relative, resolve } from "node:path"
import { Cause, Option, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceFilePath,
  type BatchExitCode,
  type BatchMutantOutcomeResult,
  type PackageBatchFileOutput,
  PackageBatchFileOutputSchema,
  type SubprocessSignalName,
} from "@harness/contract"
import type { SyncHostExecResult } from "@harness/service/host-io"
import type { CodeMutant } from "./mutant-ast-generator.js"

export { PackageBatchFileOutputSchema, type PackageBatchFileOutput }

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_ESCAPE_REGEX = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
)

export const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_REGEX, "")

/**
 * Normalizes a raw test path into a repo-relative `AstSourceFilePath`, rejecting empty strings,
 * control characters, `..` traversal segments, and escapes outside `repoRoot`.
 */
export const normalizeRepoRelTestPath = (
  repoRoot: string,
  rawPath: string,
): Option.Option<AstSourceFilePath> => {
  const trimmed = rawPath.trim()
  if (trimmed.length === 0 || /[\0\r\n]/.test(trimmed)) {
    return Option.none()
  }
  const slashNorm = trimmed.replace(/\\/g, "/")
  const resolvedRoot = resolve(repoRoot)

  if (isAbsolute(trimmed) || slashNorm.startsWith("/")) {
    const rel = relative(resolvedRoot, resolve(trimmed)).replace(/\\/g, "/")
    if (
      rel.length === 0 ||
      rel === "." ||
      isAbsolute(rel) ||
      rel.startsWith("/") ||
      rel.split("/").includes("..")
    ) {
      return Option.none()
    }
    const normalized = posix.normalize(rel).replace(/^(?:\.\/)+/, "")
    if (
      normalized.length === 0 ||
      normalized === "." ||
      normalized.startsWith("..") ||
      normalized.startsWith("/")
    ) {
      return Option.none()
    }
    return Option.some(AstSourceFilePath.make(normalized))
  }

  const stripped = slashNorm.replace(/^(?:\.\/)+/, "")
  if (stripped.length === 0 || stripped === "." || stripped.split("/").includes("..")) {
    return Option.none()
  }
  const normalized = posix.normalize(stripped).replace(/^(?:\.\/)+/, "")
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("..") ||
    normalized.startsWith("/") ||
    isAbsolute(normalized)
  ) {
    return Option.none()
  }
  return Option.some(AstSourceFilePath.make(normalized))
}

const stripVitestFailCandidate = (rawLine: string): string =>
  rawLine
    .trim()
    .replace(/^\|[^|]+\|\s+/, "")
    .replace(/\s+>.*$/, "")
    .replace(/\s+\[[^\]]*\]$/, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/\s+\[[^\]]*\]$/, "")
    .replace(/\\/g, "/")
    .trim()

/** Matches a normalized candidate test path against `targetRelSet` / `targetRelList` unambiguously. */
export const matchNormalizedTestCandidate = (
  normCand: AstSourceFilePath,
  targetRelSet: ReadonlySet<AstSourceFilePath>,
  targetRelList: ReadonlyArray<AstSourceFilePath>,
): AstSourceFilePath | undefined => {
  if (targetRelSet.has(normCand)) return normCand
  const matches = targetRelList.filter(
    (p) => p === normCand || p.endsWith(`/${normCand}`) || normCand.endsWith(`/${p}`),
  )
  return matches.length === 1 ? matches[0] : undefined
}

const matchPassCandidate = (
  repoRoot: string,
  passRelSet: ReadonlySet<AstSourceFilePath>,
  passRelList: ReadonlyArray<AstSourceFilePath>,
  rawCand: string,
): AstSourceFilePath | undefined => {
  const cleaned = stripVitestFailCandidate(rawCand)
  if (cleaned.length === 0) return undefined
  return match(normalizeRepoRelTestPath(repoRoot, cleaned))
    .with({ _tag: "None" }, () => undefined)
    .with({ _tag: "Some" }, ({ value: normCand }) =>
      matchNormalizedTestCandidate(normCand, passRelSet, passRelList),
    )
    .exhaustive()
}

/**
 * Extracts the canonical witness test file that killed a mutant from explicit batch attribution
 * or Vitest `FAIL` output lines, failing closed (`undefined`) on ambiguity.
 */
export const extractWitnessTestFileFromOutput = (
  repoRoot: string,
  passTests: ReadonlyArray<string>,
  stdout: string,
  stderr: string,
  explicitKillingTestFile?: AstSourceFilePath,
): AstSourceFilePath | undefined => {
  const passRelSet = new Set<AstSourceFilePath>()
  const passRelList: Array<AstSourceFilePath> = []
  for (const rawTest of passTests) {
    match(normalizeRepoRelTestPath(repoRoot, rawTest))
      .with({ _tag: "Some" }, ({ value }) => {
        if (!passRelSet.has(value)) {
          passRelSet.add(value)
          passRelList.push(value)
        }
      })
      .with({ _tag: "None" }, () => {})
      .exhaustive()
  }

  if (explicitKillingTestFile !== undefined) {
    const explicitHit = match(normalizeRepoRelTestPath(repoRoot, explicitKillingTestFile))
      .with({ _tag: "Some" }, ({ value }) => (passRelSet.has(value) ? value : undefined))
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (explicitHit !== undefined) return explicitHit
  }

  const failLineRe = /^\s*FAIL\s+([^\r\n]+)/gm
  for (const stream of [stripAnsi(stdout), stripAnsi(stderr)]) {
    failLineRe.lastIndex = 0
    let m: RegExpExecArray | null = failLineRe.exec(stream)
    while (m !== null) {
      const matched = matchPassCandidate(repoRoot, passRelSet, passRelList, m[1] ?? "")
      if (matched !== undefined) return matched
      m = failLineRe.exec(stream)
    }
  }

  if (passRelList.length === 1) {
    return passRelList[0]
  }
  return undefined
}

/** Formats a surviving mutant line for `--fail-fast` / `--max-survivors` reporting (`REQ-2.1`). */
export const formatSurvivorLine = (mutant: CodeMutant): string =>
  `${mutant.file}:${mutant.line}:${mutant.original}->${mutant.replacement}`

/** Extracts optional explicit `killingTestFile` from a `BatchMutantOutcomeResult`. */
export const extractBatchKillingTestFile = (
  entryRes: BatchMutantOutcomeResult,
): AstSourceFilePath | undefined =>
  match(entryRes)
    .with({ _tag: "Exited" }, (e) => e.killingTestFile)
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => undefined)
    .exhaustive()

/** Converts a contract `BatchMutantOutcomeResult` into a `SyncHostExecResult`. */
export const toBatchHostExecResult = (entryRes: BatchMutantOutcomeResult): SyncHostExecResult =>
  match(entryRes)
    .with({ _tag: "Signaled" }, (s) => {
      const signal: SubprocessSignalName = s.signal
      return { _tag: "Signaled" as const, signal, stdout: s.stdout, stderr: s.stderr }
    })
    .with({ _tag: "Exited" }, (e) => {
      const exitCode: BatchExitCode = e.exitCode
      return { _tag: "Exited" as const, exitCode, stdout: e.stdout, stderr: e.stderr }
    })
    .with({ _tag: "TimedOut" }, (t) => t)
    .with({ _tag: "SpawnFailed" }, (f) => f)
    .exhaustive()

const PackageBatchRunnerOutputSchema = Schema.fromJsonString(
  Schema.Array(PackageBatchFileOutputSchema),
)

/** Decodes `package-vitest-batch.mjs` execution result into structured per-file reports or an abort diagnostic. */
export const decodePackageBatchExecResult = (
  pkgKey: string,
  execRes: Result.Result<SyncHostExecResult, unknown>,
): Result.Result<ReadonlyArray<PackageBatchFileOutput>, string> => {
  const batchAbort = (msg: string) =>
    Result.fail<string>(`[mutation-check] Package batch runner ${msg} for '${pkgKey}'`)
  return match(execRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      batchAbort(`threw: ${failure instanceof Error ? failure.message : String(failure)}`),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Exited" }, (r) =>
          r.exitCode !== 0
            ? batchAbort(`exited with code ${r.exitCode}: ${stripAnsi(r.stderr).trim()}`)
            : match(Schema.decodeExit(PackageBatchRunnerOutputSchema)(r.stdout))
                .with({ _tag: "Success" }, ({ value }) => Result.succeed(value))
                .with({ _tag: "Failure" }, ({ cause }) =>
                  batchAbort(
                    `emitted invalid JSON schema (stdoutLen=${r.stdout.length}): ${Cause.pretty(cause).slice(0, 240)}`,
                  ),
                )
                .exhaustive(),
        )
        .with({ _tag: "TimedOut" }, () => batchAbort("timed out"))
        .with({ _tag: "Signaled" }, (r) => batchAbort(`signaled (${r.signal})`))
        .with({ _tag: "SpawnFailed" }, (r) => batchAbort(`spawn failed (${r.spawnError})`))
        .exhaustive(),
    )
    .exhaustive()
}

/**
 * Attributes a killed mutant's witness test file from a `SyncHostExecResult`, marking the mutant
 * non-cacheable when no unambiguous witness can be verified.
 */
export const attributeKillWitnessFromExecResult = (input: {
  readonly repoRoot: string
  readonly passTests: ReadonlyArray<string>
  readonly mutantId: string
  readonly execResult: SyncHostExecResult
  readonly nonCacheableIds: Set<string>
  readonly witnessByMutantId: Map<string, AstSourceFilePath>
  readonly explicitKillingTestFile?: AstSourceFilePath | undefined
}): void => {
  if (input.nonCacheableIds.has(input.mutantId)) return
  const witness = match(input.execResult)
    .with({ _tag: "Exited" }, (r) =>
      extractWitnessTestFileFromOutput(
        input.repoRoot,
        input.passTests,
        r.stdout,
        r.stderr,
        input.explicitKillingTestFile,
      ),
    )
    .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => undefined)
    .exhaustive()
  if (witness === undefined) input.nonCacheableIds.add(input.mutantId)
  else input.witnessByMutantId.set(input.mutantId, witness)
}
