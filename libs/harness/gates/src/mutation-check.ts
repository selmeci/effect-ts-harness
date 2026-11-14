/**
 * @fileoverview Mutation verification gate, mutant discovery, test execution, and span saturation analysis.
 */
import { join, relative, resolve } from "node:path"
import { Effect, Layer, Schema } from "effect"
import type { SyncHostIo } from "@harness/service"
import {
  ActiveMutantId, SubprocessArg, SubprocessCommand, SubprocessTimeoutMs, WorkspaceFilePath,
} from "./plugins/self-dogfooding-contract.js"
import {
  ActiveMutantContext, ActiveMutantContextLive, getActiveMutantId, setActiveMutantId, withActiveMutantEffect,
} from "./services/active-mutant-context.js"
import {
  execCheckedSubprocess,
  makeHarnessSubprocessRunnerHostIoLayer,
} from "./services/subprocess-runner.js"
import {
  makeWorkspaceFsHostIoLayer,
  readAndVerifyWorkspaceFile,
} from "./services/workspace-fs.js"
import {
  CodeMutant, compileMutantSchemaModule, discoverDomainMutants, evaluateMutantSchemaInProcess,
  MutantCategory, MutantOutcome, type MutantSchemaModule, parseGitDiffModifiedLines,
} from "./mutation/mutant-ast-generator.js"

export {
  MutantCategory, CodeMutant, MutantOutcome, type MutantSchemaModule,
  getActiveMutantId, setActiveMutantId, parseGitDiffModifiedLines,
  discoverDomainMutants, compileMutantSchemaModule, evaluateMutantSchemaInProcess,
}

export interface SpanSaturationSpec {
  readonly spanQualname: string
  readonly spanName: string
  readonly filePath: string
  readonly declaredErrorTags: ReadonlyArray<string>
  readonly declaredBranchTags?: ReadonlyArray<string> | undefined
}

export interface TraceSpanObservation {
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly name: string
  readonly exitTag?: "Success" | "Failure" | "Defect" | undefined
  readonly errorTag?: string | null | undefined
  readonly valueTag?: string | null | undefined
}

export interface SaturationViolation {
  readonly ruleId: "SAT-01" | "SAT-02"
  readonly kind: "unexercised-error-channel" | "shallow-branch-saturation"
  readonly spanQualname: string
  readonly spanName: string
  readonly filePath: string
  readonly missingTags: ReadonlyArray<string>
  readonly message: string
}

export type SpanSaturationObservation = TraceSpanObservation

export interface MutationEvaluationInput {
  readonly outcomes: ReadonlyArray<MutantOutcome>
  readonly minScore?: number | undefined
  readonly equivalencePriors?: Readonly<Record<string, number>> | undefined
  readonly saturationSpecs?: ReadonlyArray<SpanSaturationSpec> | undefined
  readonly traceObservations?: ReadonlyArray<TraceSpanObservation> | undefined
  readonly spanObservations?: ReadonlyArray<SpanSaturationObservation> | undefined
}

export interface MutationSuiteReport {
  readonly passed: boolean
  readonly totalMutants: number
  readonly killedCount: number
  readonly survivedCount: number
  readonly mutationScore: number
  readonly survivedMutants: ReadonlyArray<CodeMutant>
  readonly equivalentCount?: number | undefined
  readonly equivalentMutants?: ReadonlyArray<CodeMutant> | undefined
  readonly saturationViolations?: ReadonlyArray<SaturationViolation> | undefined
}

export const evaluateSpanSaturationViolations = (
  specs: ReadonlyArray<SpanSaturationSpec>,
  observations: ReadonlyArray<TraceSpanObservation>,
): ReadonlyArray<SaturationViolation> => {
  const byId = new Map<string, TraceSpanObservation>(observations.map((o) => [o.spanId, o]))

  const getAncestorSpanNamesAndSelf = (obs: TraceSpanObservation): ReadonlySet<string> => {
    const names = new Set<string>([obs.name])
    const visited = new Set<string>([obs.spanId])
    let curParentId = obs.parentSpanId
    while (curParentId !== null && !visited.has(curParentId)) {
      visited.add(curParentId)
      const parent = byId.get(curParentId)
      if (parent === undefined) break
      names.add(parent.name)
      curParentId = parent.parentSpanId
    }
    return names
  }

  const errorTagsBySpan = new Map<string, Set<string>>()
  const branchTagsBySpan = new Map<string, Set<string>>()
  const recordTag = (map: Map<string, Set<string>>, key: string, val: string) => {
    let s = map.get(key)
    if (s === undefined) {
      s = new Set<string>()
      map.set(key, s)
    }
    s.add(val)
  }

  for (const obs of observations) {
    for (const spanName of getAncestorSpanNamesAndSelf(obs)) {
      if (obs.exitTag === "Failure" && typeof obs.errorTag === "string" && obs.errorTag.length > 0) {
        recordTag(errorTagsBySpan, spanName, obs.errorTag)
        recordTag(branchTagsBySpan, spanName, obs.errorTag)
      }
      if (typeof obs.valueTag === "string" && obs.valueTag.length > 0) {
        recordTag(branchTagsBySpan, spanName, obs.valueTag)
      }
    }
  }

  const violations: Array<SaturationViolation> = []
  for (const spec of specs) {
    const observedErrors = errorTagsBySpan.get(spec.spanName) ?? new Set<string>()
    const missingErrors = spec.declaredErrorTags.filter((tag) => !observedErrors.has(tag))
    if (missingErrors.length > 0) {
      violations.push({
        ruleId: "SAT-01",
        kind: "unexercised-error-channel",
        spanQualname: spec.spanQualname,
        spanName: spec.spanName,
        filePath: spec.filePath,
        missingTags: missingErrors,
        message: `[SAT-01] Unexercised error channel(s) on '${spec.spanName}' (${spec.spanQualname}): [${missingErrors.join(", ")}] were never observed on '${spec.spanName}' or its descendant spans.`,
      })
    }

    const declaredBranches = spec.declaredBranchTags ?? []
    if (declaredBranches.length >= 2) {
      const observedBranches = branchTagsBySpan.get(spec.spanName) ?? new Set<string>()
      const missingBranches = declaredBranches.filter((tag) => !observedBranches.has(tag))
      if (missingBranches.length > 0) {
        violations.push({
          ruleId: "SAT-02",
          kind: "shallow-branch-saturation",
          spanQualname: spec.spanQualname,
          spanName: spec.spanName,
          filePath: spec.filePath,
          missingTags: missingBranches,
          message: `[SAT-02] Shallow branch saturation on '${spec.spanName}' (${spec.spanQualname}): missing branch/outcome tags [${missingBranches.join(", ")}].`,
        })
      }
    }
  }

  return violations
}

export const normalizePriorMillis = (raw: number): number =>
  raw > 0 && raw < 1 ? Math.round(raw * 1000) : Math.round(raw)

export const isMutantMarkedEquivalent = (
  outcome: MutantOutcome,
  priors: Readonly<Record<string, number>> | undefined,
  threshold = 850,
): boolean => {
  if (outcome.status === "equivalent") return true
  const prior = priors?.[outcome.mutant.id]
  if (prior === undefined) return false
  return normalizePriorMillis(prior) >= threshold
}

export const decideMutationReport = Effect.fn("MutationCheck.decide")(function* (
  input: MutationEvaluationInput,
) {
  const equivalentMutantIds = new Set(
    input.outcomes
      .filter((o) => o.status !== "killed" && isMutantMarkedEquivalent(o, input.equivalencePriors))
      .map((o) => o.mutant.id),
  )
  const equivalentMutants = input.outcomes
    .filter((o) => equivalentMutantIds.has(o.mutant.id))
    .map((o) => o.mutant)
  const survivedMutants = input.outcomes
    .filter((o) => o.status === "survived" && !equivalentMutantIds.has(o.mutant.id))
    .map((o) => o.mutant)
  const survivedCount = survivedMutants.length
  const killedCount = input.outcomes.filter((o) => o.status === "killed").length
  const totalMutants = input.outcomes.length
  const actionableMutants = totalMutants - equivalentMutants.length
  const mutationScore = actionableMutants <= 0 ? 1 : killedCount / actionableMutants
  const minScore = input.minScore ?? 1

  const observations = input.spanObservations ?? input.traceObservations
  const saturationViolations =
    input.saturationSpecs !== undefined && observations !== undefined
      ? evaluateSpanSaturationViolations(input.saturationSpecs, observations)
      : undefined

  const saturationPassed = saturationViolations === undefined || saturationViolations.length === 0
  const passed = survivedCount === 0 && mutationScore >= minScore && saturationPassed

  return yield* Effect.succeed({
    passed,
    totalMutants,
    killedCount,
    survivedCount,
    mutationScore,
    survivedMutants,
    ...(input.equivalencePriors !== undefined || equivalentMutants.length > 0
      ? { equivalentCount: equivalentMutants.length, equivalentMutants }
      : {}),
    ...(saturationViolations !== undefined ? { saturationViolations } : {}),
  } satisfies MutationSuiteReport)
})

/**
 * Decides whether the mutation suite report passes based on killed mutants,
 * minimum score threshold, equivalence priors, and span saturation specifications.
 */
export const decideMutationCheck = decideMutationReport

export const evaluateMutationOutcomes = (
  outcomes: ReadonlyArray<MutantOutcome>,
  minScore?: number,
  equivalencePriors?: Readonly<Record<string, number>>,
  saturationSpecs?: ReadonlyArray<SpanSaturationSpec>,
  spanObservations?: ReadonlyArray<SpanSaturationObservation>,
): MutationSuiteReport =>
  Effect.runSync(
    decideMutationReport({
      outcomes,
      minScore,
      equivalencePriors,
      saturationSpecs,
      spanObservations,
      traceObservations: spanObservations,
    }),
  )

interface DomainFile {
  readonly scope: string
  readonly tier: "domain" | "core" | "contract"
  readonly fullPath: string
  readonly relFile: string
}

const findDomainFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  scope?: string,
): ReadonlyArray<DomainFile> => {
  const results: Array<DomainFile> = []
  const libsDir = join(repoRoot, "libs")
  if (!hostIo.existsSync(libsDir)) return results

  const cleanScope = scope
    ? scope.replace(/^@harness\//, "").replace(/-(domain|core|contract)$/, "")
    : undefined
  const scopes =
    cleanScope !== undefined
      ? [cleanScope]
      : hostIo.readdirSync(libsDir).map((e) => e.name)

  for (const s of scopes) {
    const scopePath = join(libsDir, s)
    const tiersToScan = [
      { dir: join(scopePath, "domain", "src"), tier: "domain" as const },
      { dir: join(scopePath, "domain", "test", "fixtures"), tier: "domain" as const },
      { dir: join(scopePath, "core", "src"), tier: "core" as const },
      { dir: join(scopePath, "core", "test", "fixtures"), tier: "core" as const },
      { dir: join(scopePath, "contract", "src"), tier: "contract" as const },
    ]

    for (const { dir, tier } of tiersToScan) {
      if (!hostIo.existsSync(dir)) continue
      const walk = (d: string) => {
        for (const entry of hostIo.readdirSync(d)) {
          const full = join(d, entry.name)
          if (entry.isDirectory) {
            walk(full)
          } else if (entry.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
            if (tier === "contract") {
              const content = hostIo.readTextSync(full)
              if (content.includes("Effect.fn") || content.includes("Effect.gen") || content.includes("match(")) {
                results.push({ scope: s, tier, fullPath: full, relFile: relative(repoRoot, full).replace(/\\/g, "/") })
              }
            } else {
              results.push({ scope: s, tier, fullPath: full, relFile: relative(repoRoot, full).replace(/\\/g, "/") })
            }
          }
        }
      }
      walk(dir)
    }
  }

  return results
}

const trySyncOrElse = <A>(fn: () => A, fallback: () => A): A =>
  Effect.runSync(
    Effect.try({
      try: fn,
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(fallback)),
  )

export const extractGitDiffModifiedLines = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyMap<string, ReadonlySet<number>> | undefined => {
  const gitOpts = { cwd: repoRoot, timeoutMs: 15_000 }
  const isGit = trySyncOrElse(
    () => {
      const res = hostIo.execFileSync("git", ["rev-parse", "--is-inside-work-tree"], gitOpts)
      return res.exitCode === 0 && res.stdout.trim() === "true"
    },
    () => false,
  )
  if (!isGit) return undefined

  const runGitDiff = (args: ReadonlyArray<string>): string | null => {
    const res = hostIo.execFileSync("git", args, gitOpts)
    return res.exitCode === 0 ? res.stdout : null
  }

  const primaryDiff = trySyncOrElse<string | null>(
    () => runGitDiff(["diff", "-U0"]) ?? runGitDiff(["diff", "-U0", "HEAD"]),
    () => null,
  )
  if (primaryDiff === null) return new Map<string, ReadonlySet<number>>()

  const headDiff = trySyncOrElse(
    () => runGitDiff(["diff", "-U0", "HEAD"]) ?? "",
    () => "",
  )
  const diffOut = headDiff.length > 0 ? `${primaryDiff}\n${headDiff}` : primaryDiff
  return parseGitDiffModifiedLines(diffOut)
}

export const getWorkspaceGitDiffModifiedLines = extractGitDiffModifiedLines

export const findReachingTestFiles = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
): ReadonlyArray<string> => {
  const testDir = join(repoRoot, "libs", file.scope, file.tier, "test")
  if (!hostIo.existsSync(testDir)) return []
  const reaching: Array<string> = []
  const walk = (dir: string) => {
    for (const entry of hostIo.readdirSync(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory) walk(full)
      else if (entry.isFile && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts"))) reaching.push(full)
    }
  }
  walk(testDir)
  return reaching
}

export const collectReachingTestAssertions = (
  repoRoot: string,
  file: DomainFile,
  hostIo: SyncHostIo,
): string =>
  findReachingTestFiles(repoRoot, file, hostIo).map((full) => hostIo.readTextSync(full)).join("\n")

export interface RunMutationOptions {
  readonly scope?: string | undefined
  readonly includeAllLines?: boolean | undefined
  readonly minScore?: number | undefined
  readonly testRunner?: ((mutant: CodeMutant, schemaSource: string, reachingTestFiles: ReadonlyArray<string>) => "killed" | "survived") | undefined
  readonly spanObservations?: ReadonlyArray<SpanSaturationObservation> | undefined
  readonly saturationSpecs?: ReadonlyArray<SpanSaturationSpec> | undefined
  readonly equivalencePriors?: Readonly<Record<string, number>> | undefined
  readonly sourceCodeOverlays?: Readonly<Record<string, string>> | undefined
}

export const runDomainMutationSuite = (
  repoRoot: string,
  hostIo: SyncHostIo,
  options?: RunMutationOptions,
): MutationSuiteReport => {
  const workspaceFsLayer = makeWorkspaceFsHostIoLayer(hostIo)
  const subprocessLayer = makeHarnessSubprocessRunnerHostIoLayer(hostIo)
  const backupPath = join(repoRoot, ".harness", "mutation-backup.json")
  if (hostIo.existsSync(backupPath)) {
    let restoredOk = false
    Effect.runSync(
      Effect.gen(function* () {
        const fileStat = yield* readAndVerifyWorkspaceFile(WorkspaceFilePath.make(backupPath))
        const decodedBackupOpt = Schema.decodeOption(
          Schema.fromJsonString(
            Schema.Struct({
              filePath: Schema.optional(Schema.String),
              originalSource: Schema.optional(Schema.String),
            }),
          ),
        )(fileStat.content)
        if (decodedBackupOpt._tag === "Some") {
          const { filePath, originalSource } = decodedBackupOpt.value
          if (filePath !== undefined && originalSource !== undefined) {
            const resolvedTarget = resolve(repoRoot, filePath)
            const relTarget = relative(resolve(repoRoot), resolvedTarget).replace(/\\/g, "/")
            if (!relTarget.startsWith("..") && !relTarget.startsWith("/") && (relTarget.startsWith("libs/") || relTarget.startsWith("apps/"))) {
              hostIo.writeTextSync(resolvedTarget, originalSource)
              restoredOk = true
            }
          }
        }
      }).pipe(
        Effect.provide(workspaceFsLayer),
        Effect.orElseSucceed(() => undefined),
        Effect.ensuring(
          Effect.sync(() => {
            if (restoredOk && hostIo.existsSync(backupPath)) hostIo.unlinkSync(backupPath)
          }),
        ),
      ),
    )
  }

  const domainFiles = findDomainFiles(repoRoot, hostIo, options?.scope)
  const diffLinesMap = options?.includeAllLines === true ? undefined : extractGitDiffModifiedLines(repoRoot, hostIo)
  const outcomes: Array<MutantOutcome> = []

  for (const file of domainFiles) {
    const overlaySource = options?.sourceCodeOverlays?.[file.relFile]
    if (overlaySource === undefined && options?.includeAllLines !== true && diffLinesMap !== undefined) {
      if (!diffLinesMap.has(file.relFile)) continue
    }

    const modifiedLines =
      options?.includeAllLines === true || overlaySource !== undefined
        ? undefined
        : diffLinesMap !== undefined
          ? diffLinesMap.get(file.relFile)
          : undefined

    const originalContent =
      overlaySource ??
      Effect.runSync(
        readAndVerifyWorkspaceFile(WorkspaceFilePath.make(file.fullPath)).pipe(
          Effect.map((s) => s.content),
          Effect.provide(workspaceFsLayer),
          Effect.orElseSucceed(() => hostIo.readTextSync(file.fullPath)),
        ),
      )
    const mutants = discoverDomainMutants(
      file.relFile,
      originalContent,
      modifiedLines !== undefined && modifiedLines.size > 0 ? { modifiedLines } : undefined,
    )
    if (mutants.length === 0) continue

    const schemaBundle = compileMutantSchemaModule(file.relFile, originalContent, mutants)
    const reachingTestFiles = findReachingTestFiles(repoRoot, file, hostIo)

    if (reachingTestFiles.length === 0) {
      for (const mutant of mutants) outcomes.push({ mutant, status: "survived" })
      continue
    }

    if (options?.testRunner !== undefined) {
      const runner = options.testRunner
      Effect.runSync(
        Effect.gen(function* () {
          for (const mutant of mutants) {
            const killed = yield* withActiveMutantEffect(
              ActiveMutantId.make(mutant.id),
              () => runner(mutant, schemaBundle.schemaSource, reachingTestFiles) === "killed",
            )
            outcomes.push({ mutant, status: killed ? "killed" : "survived" })
          }
        }).pipe(Effect.provide(ActiveMutantContextLive)),
      )
      continue
    }

    if (overlaySource !== undefined) {
      const assertionContent = collectReachingTestAssertions(repoRoot, file, hostIo)
      const hasAssertions =
        assertionContent.includes("expect(") &&
        (assertionContent.includes("it(") || assertionContent.includes("it.effect"))
      for (const mutant of mutants) {
        outcomes.push({ mutant, status: hasAssertions ? "killed" : "survived" })
      }
      continue
    }

    const originalSource = originalContent
    const harnessDir = join(repoRoot, ".harness")
    if (!hostIo.existsSync(harnessDir)) hostIo.mkdirRecursiveSync(harnessDir)
    hostIo.writeTextSync(backupPath, JSON.stringify({ filePath: file.fullPath, originalSource }))
    const onProcessExit = () => {
      trySyncOrElse(() => {
        hostIo.writeTextSync(file.fullPath, originalSource)
        if (hostIo.existsSync(backupPath)) hostIo.unlinkSync(backupPath)
      }, () => undefined)
    }
    const onSigInt = () => { onProcessExit(); process.exit(130) }
    const onSigTerm = () => { onProcessExit(); process.exit(143) }
    process.once("exit", onProcessExit); process.once("SIGINT", onSigInt); process.once("SIGTERM", onSigTerm)
    Effect.runSync(
      Effect.gen(function* () {
        const mutantCtx = yield* ActiveMutantContext
        hostIo.writeTextSync(file.fullPath, schemaBundle.schemaSource)
        for (const mutant of mutants) {
          const runSubprocess = Effect.acquireUseRelease(
            Effect.sync(() => {
              const prev = process.env["HARNESS_ACTIVE_MUTANT_ID"]
              process.env["HARNESS_ACTIVE_MUTANT_ID"] = mutant.id
              return prev
            }),
            () =>
              execCheckedSubprocess({
                command: SubprocessCommand.make("pnpm"),
                args: [SubprocessArg.make("vitest"), SubprocessArg.make("run"), ...reachingTestFiles.map((f) => SubprocessArg.make(f))],
                cwd: WorkspaceFilePath.make(repoRoot),
                timeoutMs: SubprocessTimeoutMs.make(30_000),
              }).pipe(
                Effect.map(() => "survived" as const),
                Effect.catchTag("HarnessSubprocessError", (err) =>
                  Effect.succeed(err.exitCode !== 0 ? ("killed" as const) : ("survived" as const)),
                ),
              ),
            (prev) =>
              Effect.sync(() => {
                if (prev === undefined) {
                  delete process.env["HARNESS_ACTIVE_MUTANT_ID"]
                } else {
                  process.env["HARNESS_ACTIVE_MUTANT_ID"] = prev
                }
              }),
          )
          const status = yield* mutantCtx.runWithMutant(ActiveMutantId.make(mutant.id), runSubprocess)
          outcomes.push({ mutant, status })
        }
      }).pipe(
        Effect.provide(Layer.merge(subprocessLayer, ActiveMutantContextLive)),
        Effect.ensuring(
          Effect.sync(() => {
            process.removeListener("exit", onProcessExit)
            process.removeListener("SIGINT", onSigInt)
            process.removeListener("SIGTERM", onSigTerm)
            hostIo.writeTextSync(file.fullPath, originalSource)
            if (hostIo.existsSync(backupPath)) hostIo.unlinkSync(backupPath)
          }),
        ),
      ),
    )
  }

  return Effect.runSync(
    decideMutationReport({
      outcomes,
      minScore: options?.minScore,
      equivalencePriors: options?.equivalencePriors,
      saturationSpecs: options?.saturationSpecs,
      spanObservations: options?.spanObservations,
      traceObservations: options?.spanObservations,
    }),
  )
}

export const MutationCheck = {
  decide: decideMutationCheck,
  evaluateReport: evaluateMutationOutcomes,
  runSuite: runDomainMutationSuite,
  withActiveMutant: withActiveMutantEffect,
} as const
