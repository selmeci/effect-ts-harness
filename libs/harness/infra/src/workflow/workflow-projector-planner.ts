import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AttemptNumber,
  CompiledPlan,
  GitCommitSha,
  NonNegativeCount,
  OwnedRelPath,
  PackageStampHash,
  PlanSha256,
  RejectionJsonPayload,
  RunnerId,
  UnitRejection,
  WaveIndex,
  WorkUnitId,
  WorkflowAttemptKey,
  type WorkflowAttemptRecord,
  WorkflowAttemptVerdict,
  WorkflowLevel,
  WorkflowProjectionCounts,
  WorkflowRunId,
  type WorkflowRunRecord,
  WorkflowRunState,
  WorkflowStoreFailureReason,
  WorkflowUnitKey,
  WorkflowUnitKind,
  type WorkflowUnitRecord,
  WorkflowUnitStatus,
  compareCodeUnits,
  toBoundedReason,
} from "@harness/contract"
import { decodeJsonFieldSafely } from "./workflow-store-codec.js"

const encodeRejectionJson = Schema.encodeSync(Schema.fromJsonString(UnitRejection))

export const ProjectedEdgeType = Schema.Literals([
  "PlaysRunUnitRole",
  "PlaysUnitAttemptRole",
  "PlaysUnitStubRole",
  "PlaysUnitEarsRole",
  "PlaysUnitTraceabilityRole",
  "PlaysAttemptTestRole",
])
export type ProjectedEdgeType = typeof ProjectedEdgeType.Type

export const ProjectedEdgeRole = Schema.Literals([
  "run-unit",
  "unit-attempt",
  "unit-stub",
  "unit-ears",
  "unit-traceability",
  "attempt-test",
])
export type ProjectedEdgeRole = typeof ProjectedEdgeRole.Type

export const ProjectedArchimateRelation = Schema.Literals([
  "Composition",
  "Realization",
  "Association",
])
export type ProjectedArchimateRelation = typeof ProjectedArchimateRelation.Type

export const ExistingProjectedRun = Schema.Struct({
  runId: WorkflowRunId,
  level: WorkflowLevel,
  planSha: PlanSha256,
  baseSha: GitCommitSha,
  state: WorkflowRunState,
})
export type ExistingProjectedRun = typeof ExistingProjectedRun.Type

export const ExistingProjectedUnit = Schema.Struct({
  unitKey: WorkflowUnitKey,
  runId: WorkflowRunId,
  unitId: WorkUnitId,
  kind: WorkflowUnitKind,
  waveIndex: WaveIndex,
  status: WorkflowUnitStatus,
  ownedRelPaths: Schema.Array(OwnedRelPath),
})
export type ExistingProjectedUnit = typeof ExistingProjectedUnit.Type

export const ExistingProjectedAttempt = Schema.Struct({
  attemptKey: WorkflowAttemptKey,
  attempt: AttemptNumber,
  verdict: WorkflowAttemptVerdict,
  runner: Schema.NullOr(RunnerId),
  rejection: Schema.NullOr(RejectionJsonPayload),
  packageStampHash: Schema.NullOr(PackageStampHash),
})
export type ExistingProjectedAttempt = typeof ExistingProjectedAttempt.Type

export const ExistingProjectedEdge = Schema.Struct({
  edgeType: ProjectedEdgeType,
  from: Schema.NonEmptyString,
  to: Schema.NonEmptyString,
  role: ProjectedEdgeRole,
  archimateRelation: ProjectedArchimateRelation,
})
export type ExistingProjectedEdge = typeof ExistingProjectedEdge.Type

export interface ProjectedEffectFn {
  readonly qualname: string
  readonly spanName: string
  readonly file: string
  readonly isStub: boolean
  readonly exercisingTestIds?: ReadonlyArray<string> | undefined
}

export interface ProjectedEarsSpec {
  readonly id: string
  readonly enforcedByFiles: ReadonlyArray<string>
}

export interface ProjectedTraceabilityTuple {
  readonly relationId: string
  readonly earsSpecId: string | null
  readonly targetSymbolQualname: string
}

export interface ProjectedVitestCase {
  readonly testId: string
  readonly testFile: string
}

export interface WorkflowProjectionSource {
  readonly run: WorkflowRunRecord
  readonly units: ReadonlyArray<WorkflowUnitRecord>
  readonly attempts: ReadonlyArray<WorkflowAttemptRecord>
}

export interface WorkflowProjectionTargetState {
  readonly existingRun: ExistingProjectedRun | undefined
  readonly existingUnits: ReadonlyArray<ExistingProjectedUnit>
  readonly existingAttempts: ReadonlyArray<ExistingProjectedAttempt>
  readonly existingEdges: ReadonlyArray<ExistingProjectedEdge>
  readonly effectFns: ReadonlyArray<ProjectedEffectFn>
  readonly earsSpecs: ReadonlyArray<ProjectedEarsSpec>
  readonly traceabilityTuples: ReadonlyArray<ProjectedTraceabilityTuple>
  readonly vitestCases: ReadonlyArray<ProjectedVitestCase>
}

export const WorkflowProjectionPlan = Schema.TaggedUnion({
  NoOp: {
    counts: WorkflowProjectionCounts,
  },
  Mutate: {
    query: Schema.String,
    params: Schema.Record(Schema.String, Schema.Unknown),
    counts: WorkflowProjectionCounts,
  },
  InvalidPlanJson: {
    reason: WorkflowStoreFailureReason,
  },
})
export type WorkflowProjectionPlan = typeof WorkflowProjectionPlan.Type

interface PlanUnitHints {
  readonly stubKeys: ReadonlySet<string>
  readonly earsKeys: ReadonlyArray<string>
}

interface DesiredEdge {
  readonly edgeType: ProjectedEdgeType
  readonly from: string
  readonly to: string
  readonly role: string
  readonly archimateRelation: string
}

type GqParamType = "String" | "String?" | "I32" | "[String]"

const normalizeRelPath = (raw: string): string => {
  let trimmed = raw.trim()
  while (trimmed.startsWith("./")) {
    trimmed = trimmed.slice(2)
  }
  return trimmed.normalize("NFC").toLowerCase()
}

/**
 * Pure repo-relative path overlap check matching exact path or segment-boundary
 * descendant containment after NFC normalization and case-folding.
 */
const relPathsOverlap = (a: string, b: string): boolean => {
  const normA = normalizeRelPath(a)
  const normB = normalizeRelPath(b)
  if (normA.length === 0 || normB.length === 0) {
    return false
  }
  return normA === normB || normB.startsWith(`${normA}/`) || normA.startsWith(`${normB}/`)
}

/**
 * Extracts a multi-segment workspace package directory prefix (e.g. `libs/alpha` or
 * `libs/harness/infra`) from a repo-relative path so `src/` files match `test/` files
 * inside the same package without colliding on top-level roots (`libs`, `apps`).
 */
const extractPackageDirPrefix = (raw: string): string | undefined => {
  const norm = normalizeRelPath(raw)
  if (norm.length === 0) {
    return undefined
  }
  const markerMatch = /^(.*?)\/(?:src|test|tests|__tests__)(?:\/|$)/.exec(norm)
  if (markerMatch !== null) {
    const candidate = markerMatch[1]
    return candidate !== undefined && candidate.includes("/") ? candidate : undefined
  }
  const segments = norm.split("/")
  const lastSegment = segments.at(-1) ?? ""
  const dirSegments = lastSegment.includes(".") ? segments.slice(0, -1) : segments
  return dirSegments.length >= 2 ? dirSegments.join("/") : undefined
}

const sharesPackageDirPrefix = (a: string, b: string): boolean => {
  const pkgA = extractPackageDirPrefix(a)
  const pkgB = extractPackageDirPrefix(b)
  return pkgA !== undefined && pkgB !== undefined && pkgA === pkgB
}

const arraysEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((value, idx) => value === b[idx])

const extractPlanUnitHints = (
  planJson: string | undefined,
): Result.Result<ReadonlyMap<WorkUnitId, PlanUnitHints>, WorkflowStoreFailureReason> => {
  if (planJson === undefined) {
    return Result.succeed(new Map<WorkUnitId, PlanUnitHints>())
  }
  return match(decodeJsonFieldSafely(planJson, CompiledPlan))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(toBoundedReason(`Corrupt CompiledPlan JSON in run.planJson: ${failure}`)),
    )
    .with({ _tag: "Success" }, ({ success: plan }) => {
      const hints = new Map<WorkUnitId, PlanUnitHints>()
      for (const unit of plan.units) {
        match(unit)
          .with({ _tag: "PackageUnit" }, (pkgUnit) => {
            hints.set(pkgUnit.unitId, {
              stubKeys: new Set(pkgUnit.stubKeys),
              earsKeys: pkgUnit.earsKeys,
            })
          })
          .with({ _tag: "SliceUnit" }, (sliceUnit) => {
            hints.set(sliceUnit.unitId, {
              stubKeys: new Set<string>(),
              earsKeys: sliceUnit.earsKeys,
            })
          })
          .exhaustive()
      }
      return Result.succeed(hints)
    })
    .exhaustive()
}

const encodeAttemptRejection = (attempt: WorkflowAttemptRecord): RejectionJsonPayload | null =>
  match(attempt)
    .with({ verdict: "rejected" }, ({ rejection }) =>
      RejectionJsonPayload.make(encodeRejectionJson(rejection)),
    )
    .with({ verdict: "dispatched" }, { verdict: "completed" }, () => null)
    .exhaustive()

const edgeCompositeKey = (
  edgeType: ProjectedEdgeType,
  from: string,
  to: string,
  role: string,
): string => `${edgeType}::${from}::${to}::${role}`

const compareDesiredEdges = (a: DesiredEdge, b: DesiredEdge): number =>
  compareCodeUnits(a.edgeType, b.edgeType) ||
  compareCodeUnits(a.from, b.from) ||
  compareCodeUnits(a.to, b.to) ||
  compareCodeUnits(a.role, b.role)

const createParamBuilder = () => {
  const declarations: Array<string> = []
  const params: Record<string, unknown> = {}
  let index = 0

  const bind = (type: GqParamType, value: unknown): string => {
    const name = `p${index}`
    index += 1
    declarations.push(`$${name}: ${type}`)
    params[name] = value
    return `$${name}`
  }

  return { declarations, params, bind }
}

type ParamBuilder = ReturnType<typeof createParamBuilder>

const appendRunStatement = (
  builder: ParamBuilder,
  statements: Array<string>,
  run: WorkflowRunRecord,
  existingRun: ExistingProjectedRun | undefined,
): number => {
  if (existingRun === undefined) {
    const pRunId = builder.bind("String", run.runId)
    const pLevel = builder.bind("String", run.level)
    const pPlanSha = builder.bind("String", run.planSha)
    const pBaseSha = builder.bind("String", run.baseSha)
    const pState = builder.bind("String", run.state)
    statements.push(
      `  insert WorkflowRun {\n    runId: ${pRunId},\n    level: ${pLevel},\n    planSha: ${pPlanSha},\n    baseSha: ${pBaseSha},\n    state: ${pState}\n  }`,
    )
    return 1
  }
  if (
    existingRun.level === run.level &&
    existingRun.planSha === run.planSha &&
    existingRun.baseSha === run.baseSha &&
    existingRun.state === run.state
  ) {
    return 0
  }
  const pLevel = builder.bind("String", run.level)
  const pPlanSha = builder.bind("String", run.planSha)
  const pBaseSha = builder.bind("String", run.baseSha)
  const pState = builder.bind("String", run.state)
  const pRunId = builder.bind("String", run.runId)
  statements.push(
    `  update WorkflowRun set {\n    level: ${pLevel},\n    planSha: ${pPlanSha},\n    baseSha: ${pBaseSha},\n    state: ${pState}\n  } where runId = ${pRunId}`,
  )
  return 1
}

const appendUnitStatement = (
  builder: ParamBuilder,
  statements: Array<string>,
  unit: WorkflowUnitRecord,
  existingUnit: ExistingProjectedUnit | undefined,
): number => {
  if (existingUnit === undefined) {
    const pUnitKey = builder.bind("String", unit.unitKey)
    const pRunId = builder.bind("String", unit.runId)
    const pUnitId = builder.bind("String", unit.unitId)
    const pKind = builder.bind("String", unit.kind)
    const pWaveIndex = builder.bind("I32", unit.waveIndex)
    const pStatus = builder.bind("String", unit.status)
    const pOwnedRelPaths = builder.bind("[String]", [...unit.ownedRelPaths])
    statements.push(
      `  insert WorkUnit {\n    unitKey: ${pUnitKey},\n    runId: ${pRunId},\n    unitId: ${pUnitId},\n    kind: ${pKind},\n    waveIndex: ${pWaveIndex},\n    status: ${pStatus},\n    ownedRelPaths: ${pOwnedRelPaths}\n  }`,
    )
    return 1
  }
  if (
    existingUnit.runId === unit.runId &&
    existingUnit.unitId === unit.unitId &&
    existingUnit.kind === unit.kind &&
    existingUnit.waveIndex === unit.waveIndex &&
    existingUnit.status === unit.status &&
    arraysEqual(existingUnit.ownedRelPaths, unit.ownedRelPaths)
  ) {
    return 0
  }
  const pRunId = builder.bind("String", unit.runId)
  const pUnitId = builder.bind("String", unit.unitId)
  const pKind = builder.bind("String", unit.kind)
  const pWaveIndex = builder.bind("I32", unit.waveIndex)
  const pStatus = builder.bind("String", unit.status)
  const pOwnedRelPaths = builder.bind("[String]", [...unit.ownedRelPaths])
  const pUnitKey = builder.bind("String", unit.unitKey)
  statements.push(
    `  update WorkUnit set {\n    runId: ${pRunId},\n    unitId: ${pUnitId},\n    kind: ${pKind},\n    waveIndex: ${pWaveIndex},\n    status: ${pStatus},\n    ownedRelPaths: ${pOwnedRelPaths}\n  } where unitKey = ${pUnitKey}`,
  )
  return 1
}

const appendAttemptStatement = (
  builder: ParamBuilder,
  statements: Array<string>,
  attempt: WorkflowAttemptRecord,
  existingAttempt: ExistingProjectedAttempt | undefined,
): number => {
  const runner = attempt.runner ?? null
  const rejection = encodeAttemptRejection(attempt)
  const packageStampHash = attempt.packageStampHash ?? null
  if (existingAttempt === undefined) {
    const pAttemptKey = builder.bind("String", attempt.attemptKey)
    const pAttempt = builder.bind("I32", attempt.attempt)
    const pVerdict = builder.bind("String", attempt.verdict)
    const pRunner = builder.bind("String?", runner)
    const pRejection = builder.bind("String?", rejection)
    const pStampHash = builder.bind("String?", packageStampHash)
    statements.push(
      `  insert UnitAttempt {\n    attemptKey: ${pAttemptKey},\n    attempt: ${pAttempt},\n    verdict: ${pVerdict},\n    runner: ${pRunner},\n    rejection: ${pRejection},\n    packageStampHash: ${pStampHash}\n  }`,
    )
    return 1
  }
  if (
    existingAttempt.attempt === attempt.attempt &&
    existingAttempt.verdict === attempt.verdict &&
    existingAttempt.runner === runner &&
    existingAttempt.rejection === rejection &&
    existingAttempt.packageStampHash === packageStampHash
  ) {
    return 0
  }
  const pAttempt = builder.bind("I32", attempt.attempt)
  const pVerdict = builder.bind("String", attempt.verdict)
  const pRunner = builder.bind("String?", runner)
  const pRejection = builder.bind("String?", rejection)
  const pStampHash = builder.bind("String?", packageStampHash)
  const pAttemptKey = builder.bind("String", attempt.attemptKey)
  statements.push(
    `  update UnitAttempt set {\n    attempt: ${pAttempt},\n    verdict: ${pVerdict},\n    runner: ${pRunner},\n    rejection: ${pRejection},\n    packageStampHash: ${pStampHash}\n  } where attemptKey = ${pAttemptKey}`,
  )
  return 1
}

/**
 * Pure deterministic diff & GQ 2.1 mutation planner projecting `WorkflowRunRecord`,
 * `WorkflowUnitRecord`, `WorkflowAttemptRecord`, and all 6 keyed `Plays*Role` edges
 * into graph `harness` without dangling references (`SPEC-0038`).
 *
 * Wave projection is explicitly upsert-only: it inserts missing nodes/edges and updates
 * drifted node properties, never deleting stale/extra existing edges until `done`
 * (`mode: "overwrite"`) rebuilds the branch.
 */
const planWorkflowProjection = (
  source: WorkflowProjectionSource,
  targetState: WorkflowProjectionTargetState,
): WorkflowProjectionPlan =>
  match(extractPlanUnitHints(source.run.planJson))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "InvalidPlanJson" as const,
      reason: failure,
    }))
    .with({ _tag: "Success" }, ({ success: hintsByUnitId }) =>
      planWorkflowProjectionWithHints(source, targetState, hintsByUnitId),
    )
    .exhaustive()

const planWorkflowProjectionWithHints = (
  source: WorkflowProjectionSource,
  targetState: WorkflowProjectionTargetState,
  hintsByUnitId: ReadonlyMap<WorkUnitId, PlanUnitHints>,
): WorkflowProjectionPlan => {
  const { run } = source

  const sortedUnits = [...source.units]
    .filter((u) => u.runId === run.runId)
    .sort((a, b) => compareCodeUnits(a.unitKey, b.unitKey))
  const sortedAttempts = [...source.attempts]
    .filter((a) => a.runId === run.runId)
    .sort((a, b) => compareCodeUnits(a.attemptKey, b.attemptKey))

  const dedupedUnits = new Map<string, WorkflowUnitRecord>()
  const unitByUnitId = new Map<WorkUnitId, WorkflowUnitRecord>()
  for (const unit of sortedUnits) {
    dedupedUnits.set(unit.unitKey, unit)
    unitByUnitId.set(unit.unitId, unit)
  }

  const dedupedAttempts = new Map<string, WorkflowAttemptRecord>()
  for (const attempt of sortedAttempts) {
    dedupedAttempts.set(attempt.attemptKey, attempt)
  }

  const existingUnitsByKey = new Map(targetState.existingUnits.map((u) => [u.unitKey, u]))
  const existingAttemptsByKey = new Map(targetState.existingAttempts.map((a) => [a.attemptKey, a]))
  const existingEdgeKeys = new Set(
    targetState.existingEdges.map((e) => edgeCompositeKey(e.edgeType, e.from, e.to, e.role)),
  )

  const builder = createParamBuilder()
  const statements: Array<string> = []
  const runsUpserted = appendRunStatement(builder, statements, run, targetState.existingRun)
  let unitsUpserted = 0
  let attemptsUpserted = 0

  for (const unit of dedupedUnits.values()) {
    unitsUpserted += appendUnitStatement(
      builder,
      statements,
      unit,
      existingUnitsByKey.get(unit.unitKey),
    )
  }

  for (const attempt of dedupedAttempts.values()) {
    attemptsUpserted += appendAttemptStatement(
      builder,
      statements,
      attempt,
      existingAttemptsByKey.get(attempt.attemptKey),
    )
  }

  const desiredEdgesByKey = new Map<string, DesiredEdge>()
  const addDesiredEdge = (edge: DesiredEdge): void => {
    const key = edgeCompositeKey(edge.edgeType, edge.from, edge.to, edge.role)
    if (!desiredEdgesByKey.has(key)) {
      desiredEdgesByKey.set(key, edge)
    }
  }

  const matchedEffectFnQualnamesByUnitId = new Map<WorkUnitId, ReadonlySet<string>>()
  const matchedSpecIdsByUnitId = new Map<WorkUnitId, ReadonlySet<string>>()
  const exercisingTestIdsByUnitId = new Map<WorkUnitId, ReadonlySet<string>>()

  for (const unit of dedupedUnits.values()) {
    addDesiredEdge({
      edgeType: "PlaysRunUnitRole",
      from: run.runId,
      to: unit.unitKey,
      role: "run-unit",
      archimateRelation: "Composition",
    })

    const hints = hintsByUnitId.get(unit.unitId)
    const stubKeys = hints?.stubKeys ?? new Set<string>()
    const earsKeys = hints?.earsKeys ?? []

    const matchedFnQualnames = new Set<string>()
    const exercisingTestIds = new Set<string>()
    for (const fn of targetState.effectFns) {
      const matchesFn =
        stubKeys.has(fn.qualname) ||
        stubKeys.has(fn.spanName) ||
        (fn.isStub && unit.ownedRelPaths.some((owned) => relPathsOverlap(fn.file, owned)))
      if (matchesFn) {
        matchedFnQualnames.add(fn.qualname)
        for (const testId of fn.exercisingTestIds ?? []) {
          exercisingTestIds.add(testId)
        }
        addDesiredEdge({
          edgeType: "PlaysUnitStubRole",
          from: unit.unitKey,
          to: fn.qualname,
          role: "unit-stub",
          archimateRelation: "Realization",
        })
      }
    }
    matchedEffectFnQualnamesByUnitId.set(unit.unitId, matchedFnQualnames)
    exercisingTestIdsByUnitId.set(unit.unitId, exercisingTestIds)

    const matchedSpecIds = new Set<string>()
    for (const spec of targetState.earsSpecs) {
      const matchesSpec =
        earsKeys.some((key) => key === spec.id || key.startsWith(`${spec.id}::`)) ||
        spec.enforcedByFiles.some((file) =>
          unit.ownedRelPaths.some((owned) => relPathsOverlap(file, owned)),
        )
      if (matchesSpec) {
        matchedSpecIds.add(spec.id)
        addDesiredEdge({
          edgeType: "PlaysUnitEarsRole",
          from: unit.unitKey,
          to: spec.id,
          role: "unit-ears",
          archimateRelation: "Realization",
        })
      }
    }
    matchedSpecIdsByUnitId.set(unit.unitId, matchedSpecIds)

    for (const tuple of targetState.traceabilityTuples) {
      const matchesTuple =
        (tuple.earsSpecId !== null && matchedSpecIds.has(tuple.earsSpecId)) ||
        matchedFnQualnames.has(tuple.targetSymbolQualname)
      if (matchesTuple) {
        addDesiredEdge({
          edgeType: "PlaysUnitTraceabilityRole",
          from: unit.unitKey,
          to: tuple.relationId,
          role: "unit-traceability",
          archimateRelation: "Association",
        })
      }
    }
  }

  for (const attempt of dedupedAttempts.values()) {
    const unit = unitByUnitId.get(attempt.unitId)
    if (unit === undefined) {
      continue
    }
    addDesiredEdge({
      edgeType: "PlaysUnitAttemptRole",
      from: unit.unitKey,
      to: attempt.attemptKey,
      role: "unit-attempt",
      archimateRelation: "Composition",
    })
    const exercisingTestIds = exercisingTestIdsByUnitId.get(unit.unitId) ?? new Set<string>()
    const directMatchedTests = targetState.vitestCases.filter(
      (testCase) =>
        exercisingTestIds.has(testCase.testId) ||
        unit.ownedRelPaths.some((owned) => relPathsOverlap(testCase.testFile, owned)),
    )
    const matchedTests =
      directMatchedTests.length > 0
        ? directMatchedTests
        : targetState.vitestCases.filter((testCase) =>
            unit.ownedRelPaths.some((owned) => sharesPackageDirPrefix(testCase.testFile, owned)),
          )
    for (const testCase of matchedTests) {
      addDesiredEdge({
        edgeType: "PlaysAttemptTestRole",
        from: attempt.attemptKey,
        to: testCase.testId,
        role: "attempt-test",
        archimateRelation: "Association",
      })
    }
  }

  const missingEdges = [...desiredEdgesByKey.entries()]
    .filter(([key]) => !existingEdgeKeys.has(key))
    .map(([, edge]) => edge)
    .sort(compareDesiredEdges)

  for (const edge of missingEdges) {
    const pFrom = builder.bind("String", edge.from)
    const pTo = builder.bind("String", edge.to)
    statements.push(
      `  insert ${edge.edgeType} {\n    from: ${pFrom},\n    to: ${pTo},\n    role: "${edge.role}",\n    archimateRelation: "${edge.archimateRelation}"\n  }`,
    )
  }

  const counts: WorkflowProjectionCounts = {
    runsUpserted: NonNegativeCount.make(runsUpserted),
    unitsUpserted: NonNegativeCount.make(unitsUpserted),
    attemptsUpserted: NonNegativeCount.make(attemptsUpserted),
    edgesUpserted: NonNegativeCount.make(missingEdges.length),
  }

  if (statements.length === 0) {
    return {
      _tag: "NoOp",
      counts,
    }
  }

  const query = `query project_workflow_run(\n  ${builder.declarations.join(",\n  ")}\n) {\n${statements.join("\n")}\n}`
  return {
    _tag: "Mutate",
    query,
    params: builder.params,
    counts,
  }
}

export { extractPackageDirPrefix, planWorkflowProjection, relPathsOverlap }
