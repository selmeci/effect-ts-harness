import { Data, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type OmnigraphBranchName,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkflowRunId,
} from "@harness/contract"
import { type OmnigraphClient } from "@harness/graph"
import {
  type ExistingProjectedAttempt,
  type ExistingProjectedEdge,
  type ExistingProjectedRun,
  type ExistingProjectedUnit,
  type ProjectedEarsSpec,
  type ProjectedEdgeType,
  type ProjectedEffectFn,
  type ProjectedTraceabilityTuple,
  type ProjectedVitestCase,
  type WorkflowProjectionTargetState,
} from "./workflow-projector-planner.js"
import { parseFiniteNumberOrString } from "./workflow-store-codec.js"

type Omnigraph = InstanceType<typeof OmnigraphClient>

export class WorkflowProjectorCallError extends Data.TaggedError("WorkflowProjectorCallError")<{
  readonly cause: unknown
}> {}

const RowsEnvelopeSchema = Schema.Struct({
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  graphCommitId: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodeRowsEnvelopeOption = Schema.decodeUnknownOption(RowsEnvelopeSchema)

const QUERY_EXISTING_RUN = `query q_run($runId: String) {
  match {
    $r: WorkflowRun
    $r.runId = $runId
  }
  return {
    $r.runId as runId,
    $r.level as level,
    $r.planSha as planSha,
    $r.baseSha as baseSha,
    $r.state as state
  }
}`

const QUERY_EXISTING_UNITS = `query q_units($runId: String) {
  match {
    $u: WorkUnit
    $u.runId = $runId
  }
  return {
    $u.unitKey as unitKey,
    $u.runId as runId,
    $u.unitId as unitId,
    $u.kind as kind,
    $u.waveIndex as waveIndex,
    $u.status as status,
    $u.ownedRelPaths as ownedRelPaths
  }
}`

const QUERY_EXISTING_ATTEMPTS = `query q_attempts($attemptKeys: [String]) {
  match {
    $a: UnitAttempt
    $a.attemptKey in $attemptKeys
  }
  return {
    $a.attemptKey as attemptKey,
    $a.attempt as attempt,
    $a.verdict as verdict,
    $a.runner as runner,
    $a.rejection as rejection,
    $a.packageStampHash as packageStampHash
  }
}`

const QUERY_RUN_UNIT_EDGES = `query q_run_unit_edges($runId: String) {
  match {
    $r: WorkflowRun
    $r.runId = $runId
    $u: WorkUnit
    $r $rel:playsRunUnitRole $u
  }
  return {
    $r.runId as from,
    $u.unitKey as to,
    $rel.role as role,
    $rel.archimateRelation as archimateRelation
  }
}`

const QUERY_UNIT_ATTEMPT_EDGES = `query q_unit_attempt_edges($runId: String) {
  match {
    $u: WorkUnit
    $u.runId = $runId
    $a: UnitAttempt
    $u $rel:playsUnitAttemptRole $a
  }
  return {
    $u.unitKey as from,
    $a.attemptKey as to,
    $rel.role as role,
    $rel.archimateRelation as archimateRelation
  }
}`

const QUERY_UNIT_STUB_EDGES = `query q_unit_stub_edges($runId: String) {
  match {
    $u: WorkUnit
    $u.runId = $runId
    $fn: EffectFn
    $u $rel:playsUnitStubRole $fn
  }
  return {
    $u.unitKey as from,
    $fn.qualname as to,
    $rel.role as role,
    $rel.archimateRelation as archimateRelation
  }
}`

const QUERY_UNIT_EARS_EDGES = `query q_unit_ears_edges($runId: String) {
  match {
    $u: WorkUnit
    $u.runId = $runId
    $s: EarsSpec
    $u $rel:playsUnitEarsRole $s
  }
  return {
    $u.unitKey as from,
    $s.id as to,
    $rel.role as role,
    $rel.archimateRelation as archimateRelation
  }
}`

const QUERY_UNIT_TRACEABILITY_EDGES = `query q_unit_trace_edges($runId: String) {
  match {
    $u: WorkUnit
    $u.runId = $runId
    $t: TraceabilityTuple
    $u $rel:playsUnitTraceabilityRole $t
  }
  return {
    $u.unitKey as from,
    $t.relationId as to,
    $rel.role as role,
    $rel.archimateRelation as archimateRelation
  }
}`

const QUERY_ATTEMPT_TEST_EDGES = `query q_attempt_test_edges($attemptKeys: [String]) {
  match {
    $a: UnitAttempt
    $a.attemptKey in $attemptKeys
    $v: VitestCase
    $a $rel:playsAttemptTestRole $v
  }
  return {
    $a.attemptKey as from,
    $v.testId as to,
    $rel.role as role,
    $rel.archimateRelation as archimateRelation
  }
}`

const QUERY_EFFECT_FNS = `query q_effect_fns() {
  match {
    $fn: EffectFn
  }
  return {
    $fn.qualname as qualname,
    $fn.spanName as spanName,
    $fn.file as file,
    $fn.isStub as isStub
  }
}`

const QUERY_EARS_SPECS = `query q_ears_specs() {
  match {
    $s: EarsSpec
  }
  return {
    $s.id as id,
    $s.enforcedByFiles as enforcedByFiles
  }
}`

const QUERY_TRACEABILITY_TUPLES = `query q_traceability_tuples() {
  match {
    $t: TraceabilityTuple
  }
  return {
    $t.relationId as relationId,
    $t.earsSpecId as earsSpecId,
    $t.targetSymbolQualname as targetSymbolQualname
  }
}`

const QUERY_VITEST_CASES = `query q_vitest_cases() {
  match {
    $v: VitestCase
  }
  return {
    $v.testId as testId,
    $v.testFile as testFile
  }
}`

const QUERY_EXERCISING_TESTS = `query q_exercising_tests() {
  match {
    $tt: TraceabilityTuple
    $fn: EffectFn
    $test: VitestCase
    $tt playsExercisedSpanRole $fn
    $tt playsExercisingTestRole $test
  }
  return {
    $fn.qualname as qualname,
    $test.testId as testId
  }
}`

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const decodeExistingEdges = (
  edgeType: ProjectedEdgeType,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyArray<ExistingProjectedEdge> => {
  const edges: Array<ExistingProjectedEdge> = []
  for (const row of rows) {
    const from = asString(row.from)
    const to = asString(row.to)
    const role = asString(row.role)
    const archimateRelation = asString(row.archimateRelation)
    if (
      from !== undefined &&
      to !== undefined &&
      role !== undefined &&
      archimateRelation !== undefined
    ) {
      edges.push({ edgeType, from, to, role, archimateRelation })
    }
  }
  return edges
}

const runTimedOmnigraphCall = <A>(
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, WorkflowProjectorCallError> =>
  Effect.tryPromise({
    try: (fiberSignal) =>
      fn(
        AbortSignal.any([
          fiberSignal,
          AbortSignal.timeout(WORKFLOW_TIMEOUT_BUDGETS.projectorHttpTimeoutMs),
        ]),
      ),
    catch: (cause) => new WorkflowProjectorCallError({ cause }),
  })

const queryBranchRows = (
  og: Omnigraph,
  branch: OmnigraphBranchName,
  query: string,
  params?: Readonly<Record<string, unknown>>,
): Effect.Effect<
  {
    readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
    readonly graphCommitId: string | undefined
  },
  WorkflowProjectorCallError
> =>
  runTimedOmnigraphCall((signal) =>
    og.query(
      {
        branch,
        query,
        ...(params !== undefined ? { params } : {}),
      },
      { signal },
    ),
  ).pipe(
    Effect.flatMap((raw) =>
      match(decodeRowsEnvelopeOption(raw))
        .with({ _tag: "Some" }, ({ value }) =>
          Effect.succeed({
            rows: value.rows,
            graphCommitId: value.graphCommitId ?? undefined,
          }),
        )
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowProjectorCallError({
              cause: "Omnigraph query response missing rows envelope",
            }),
          ),
        )
        .exhaustive(),
    ),
  )

/**
 * Reads existing projected workflow nodes/edges and target analytical entities from
 * graph `harness` on `branch`, returning both the snapshot and head `graphCommitId`.
 */
export const readTargetStateSnapshot = Effect.fn("WorkflowProjector.readTargetState")(function* (
  og: Omnigraph,
  branch: OmnigraphBranchName,
  runId: WorkflowRunId,
  attemptKeys: ReadonlyArray<string>,
) {
  const emptyEnvelope = {
    rows: [] as ReadonlyArray<Readonly<Record<string, unknown>>>,
    graphCommitId: undefined,
  }

  const [
    runRes,
    unitsRes,
    attemptsRes,
    runUnitEdgesRes,
    unitAttemptEdgesRes,
    unitStubEdgesRes,
    unitEarsEdgesRes,
    unitTraceEdgesRes,
    attemptTestEdgesRes,
    effectFnsRes,
    earsSpecsRes,
    traceTuplesRes,
    vitestCasesRes,
    exercisingRes,
  ] = yield* Effect.all(
    [
      queryBranchRows(og, branch, QUERY_EXISTING_RUN, { runId }),
      queryBranchRows(og, branch, QUERY_EXISTING_UNITS, { runId }),
      attemptKeys.length > 0
        ? queryBranchRows(og, branch, QUERY_EXISTING_ATTEMPTS, { attemptKeys })
        : Effect.succeed(emptyEnvelope),
      queryBranchRows(og, branch, QUERY_RUN_UNIT_EDGES, { runId }),
      queryBranchRows(og, branch, QUERY_UNIT_ATTEMPT_EDGES, { runId }),
      queryBranchRows(og, branch, QUERY_UNIT_STUB_EDGES, { runId }),
      queryBranchRows(og, branch, QUERY_UNIT_EARS_EDGES, { runId }),
      queryBranchRows(og, branch, QUERY_UNIT_TRACEABILITY_EDGES, { runId }),
      attemptKeys.length > 0
        ? queryBranchRows(og, branch, QUERY_ATTEMPT_TEST_EDGES, { attemptKeys })
        : Effect.succeed(emptyEnvelope),
      queryBranchRows(og, branch, QUERY_EFFECT_FNS),
      queryBranchRows(og, branch, QUERY_EARS_SPECS),
      queryBranchRows(og, branch, QUERY_TRACEABILITY_TUPLES),
      queryBranchRows(og, branch, QUERY_VITEST_CASES),
      queryBranchRows(og, branch, QUERY_EXERCISING_TESTS),
    ],
    { concurrency: 4 },
  )

  const observedCommitIds = [
    runRes.graphCommitId,
    unitsRes.graphCommitId,
    attemptsRes.graphCommitId,
    runUnitEdgesRes.graphCommitId,
    unitAttemptEdgesRes.graphCommitId,
    unitStubEdgesRes.graphCommitId,
    unitEarsEdgesRes.graphCommitId,
    unitTraceEdgesRes.graphCommitId,
    attemptTestEdgesRes.graphCommitId,
    effectFnsRes.graphCommitId,
    earsSpecsRes.graphCommitId,
    traceTuplesRes.graphCommitId,
    vitestCasesRes.graphCommitId,
    exercisingRes.graphCommitId,
  ].filter((id): id is string => id !== undefined)

  const commitId = observedCommitIds[0]
  if (commitId !== undefined && observedCommitIds.some((id) => id !== commitId)) {
    return yield* new WorkflowProjectorCallError({
      cause: Object.assign(new Error("Concurrent graph commit detected during snapshot read"), {
        status: 412,
      }),
    })
  }

  const firstRunRow = runRes.rows[0]
  let existingRun: ExistingProjectedRun | undefined
  if (firstRunRow !== undefined) {
    const rId = asString(firstRunRow.runId)
    const level = asString(firstRunRow.level)
    const planSha = asString(firstRunRow.planSha)
    const baseSha = asString(firstRunRow.baseSha)
    const state = asString(firstRunRow.state)
    if (
      rId !== undefined &&
      level !== undefined &&
      planSha !== undefined &&
      baseSha !== undefined &&
      state !== undefined
    ) {
      existingRun = { runId: rId, level, planSha, baseSha, state }
    }
  }

  const existingUnits: Array<ExistingProjectedUnit> = []
  for (const row of unitsRes.rows) {
    const unitKey = asString(row.unitKey)
    const uRunId = asString(row.runId)
    const unitId = asString(row.unitId)
    const kind = asString(row.kind)
    const waveIndex = parseFiniteNumberOrString(row.waveIndex)
    const status = asString(row.status)
    if (
      unitKey !== undefined &&
      uRunId !== undefined &&
      unitId !== undefined &&
      kind !== undefined &&
      waveIndex !== undefined &&
      status !== undefined
    ) {
      existingUnits.push({
        unitKey,
        runId: uRunId,
        unitId,
        kind,
        waveIndex,
        status,
        ownedRelPaths: asStringArray(row.ownedRelPaths),
      })
    }
  }

  const existingAttempts: Array<ExistingProjectedAttempt> = []
  for (const row of attemptsRes.rows) {
    const attemptKey = asString(row.attemptKey)
    const attemptNum = parseFiniteNumberOrString(row.attempt)
    const verdict = asString(row.verdict)
    if (attemptKey !== undefined && attemptNum !== undefined && verdict !== undefined) {
      existingAttempts.push({
        attemptKey,
        attempt: attemptNum,
        verdict,
        runner: asNullableString(row.runner),
        rejection: asNullableString(row.rejection),
        packageStampHash: asNullableString(row.packageStampHash),
      })
    }
  }

  const existingEdges: ReadonlyArray<ExistingProjectedEdge> = [
    ...decodeExistingEdges("PlaysRunUnitRole", runUnitEdgesRes.rows),
    ...decodeExistingEdges("PlaysUnitAttemptRole", unitAttemptEdgesRes.rows),
    ...decodeExistingEdges("PlaysUnitStubRole", unitStubEdgesRes.rows),
    ...decodeExistingEdges("PlaysUnitEarsRole", unitEarsEdgesRes.rows),
    ...decodeExistingEdges("PlaysUnitTraceabilityRole", unitTraceEdgesRes.rows),
    ...decodeExistingEdges("PlaysAttemptTestRole", attemptTestEdgesRes.rows),
  ]

  const exercisingTestsByFn = new Map<string, Array<string>>()
  for (const row of exercisingRes.rows) {
    const qualname = asString(row.qualname)
    const testId = asString(row.testId)
    if (qualname !== undefined && testId !== undefined) {
      const list = exercisingTestsByFn.get(qualname)
      if (list !== undefined) {
        list.push(testId)
      } else {
        exercisingTestsByFn.set(qualname, [testId])
      }
    }
  }

  const effectFns: Array<ProjectedEffectFn> = []
  for (const row of effectFnsRes.rows) {
    const qualname = asString(row.qualname)
    const spanName = asString(row.spanName)
    const file = asString(row.file)
    if (qualname !== undefined && spanName !== undefined && file !== undefined) {
      effectFns.push({
        qualname,
        spanName,
        file,
        isStub: row.isStub === true,
        exercisingTestIds: exercisingTestsByFn.get(qualname),
      })
    }
  }

  const earsSpecs: Array<ProjectedEarsSpec> = []
  for (const row of earsSpecsRes.rows) {
    const id = asString(row.id)
    if (id !== undefined) {
      earsSpecs.push({
        id,
        enforcedByFiles: asStringArray(row.enforcedByFiles),
      })
    }
  }

  const traceabilityTuples: Array<ProjectedTraceabilityTuple> = []
  for (const row of traceTuplesRes.rows) {
    const relationId = asString(row.relationId)
    const targetSymbolQualname = asString(row.targetSymbolQualname)
    if (relationId !== undefined && targetSymbolQualname !== undefined) {
      traceabilityTuples.push({
        relationId,
        earsSpecId: asNullableString(row.earsSpecId),
        targetSymbolQualname,
      })
    }
  }

  const vitestCases: Array<ProjectedVitestCase> = []
  for (const row of vitestCasesRes.rows) {
    const testId = asString(row.testId)
    const testFile = asString(row.testFile)
    if (testId !== undefined && testFile !== undefined) {
      vitestCases.push({ testId, testFile })
    }
  }

  const targetState: WorkflowProjectionTargetState = {
    existingRun,
    existingUnits,
    existingAttempts,
    existingEdges,
    effectFns,
    earsSpecs,
    traceabilityTuples,
    vitestCases,
  }

  return { targetState, graphCommitId: commitId }
})

export { runTimedOmnigraphCall }
