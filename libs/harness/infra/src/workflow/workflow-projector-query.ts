import { Data, Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type OmnigraphBranchName,
  OmnigraphCommitId,
  WORKFLOW_TIMEOUT_BUDGETS,
  type WorkflowRunId,
} from "@harness/contract"
import { type OmnigraphClient } from "@harness/graph"
import {
  ExistingProjectedAttempt,
  ExistingProjectedEdge,
  ExistingProjectedRun,
  ExistingProjectedUnit,
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
  truncated: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hasMore: Schema.optional(Schema.NullOr(Schema.Boolean)),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodeRowsEnvelopeOption = Schema.decodeUnknownOption(RowsEnvelopeSchema)
const decodeCommitIdOption = Schema.decodeUnknownOption(OmnigraphCommitId)

const decodeExistingRunOption = Schema.decodeUnknownOption(ExistingProjectedRun)
const decodeExistingUnitOption = Schema.decodeUnknownOption(ExistingProjectedUnit)
const decodeExistingAttemptOption = Schema.decodeUnknownOption(ExistingProjectedAttempt)
const decodeExistingEdgeOption = Schema.decodeUnknownOption(ExistingProjectedEdge)

const EffectFnRowSchema = Schema.Struct({
  qualname: Schema.NonEmptyString,
  spanName: Schema.NonEmptyString,
  file: Schema.NonEmptyString,
  isStub: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
const decodeEffectFnRowOption = Schema.decodeUnknownOption(EffectFnRowSchema)

const EarsSpecRowSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  enforcedByFiles: Schema.Array(Schema.String),
})
const decodeEarsSpecRowOption = Schema.decodeUnknownOption(EarsSpecRowSchema)

const TraceabilityTupleRowSchema = Schema.Struct({
  relationId: Schema.NonEmptyString,
  earsSpecId: Schema.optional(Schema.NullOr(Schema.String)),
  targetSymbolQualname: Schema.NonEmptyString,
})
const decodeTraceabilityTupleRowOption = Schema.decodeUnknownOption(TraceabilityTupleRowSchema)

const VitestCaseRowSchema = Schema.Struct({
  testId: Schema.NonEmptyString,
  testFile: Schema.NonEmptyString,
})
const decodeVitestCaseRowOption = Schema.decodeUnknownOption(VitestCaseRowSchema)

const ExercisingTestRowSchema = Schema.Struct({
  qualname: Schema.NonEmptyString,
  testId: Schema.NonEmptyString,
})
const decodeExercisingTestRowOption = Schema.decodeUnknownOption(ExercisingTestRowSchema)

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

const decodeRowsOrCountDropped = <A>(
  entityKind: string,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  decodeRow: (row: Readonly<Record<string, unknown>>) => Option.Option<A>,
  droppedByKind: Map<string, number>,
): Array<A> => {
  const decoded: Array<A> = []
  let dropped = 0
  for (const row of rows) {
    match(decodeRow(row))
      .with({ _tag: "Some" }, ({ value }) => {
        decoded.push(value)
      })
      .with({ _tag: "None" }, () => {
        dropped += 1
      })
      .exhaustive()
  }
  if (dropped > 0) {
    droppedByKind.set(entityKind, (droppedByKind.get(entityKind) ?? 0) + dropped)
  }
  return decoded
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
    readonly graphCommitId: OmnigraphCommitId
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
        .with({ _tag: "Some" }, ({ value }) => {
          if (
            value.truncated === true ||
            value.hasMore === true ||
            (value.nextCursor !== undefined && value.nextCursor !== null)
          ) {
            return Effect.fail(
              new WorkflowProjectorCallError({
                cause: new Error(
                  `Omnigraph query response truncated or paginated (truncated=${String(value.truncated)}, hasMore=${String(value.hasMore)}, nextCursor=${String(value.nextCursor)})`,
                ),
              }),
            )
          }
          return match(decodeCommitIdOption(value.graphCommitId))
            .with({ _tag: "Some" }, ({ value: graphCommitId }) =>
              Effect.succeed({
                rows: value.rows,
                graphCommitId,
              }),
            )
            .with({ _tag: "None" }, () =>
              Effect.fail(
                new WorkflowProjectorCallError({
                  cause: new Error("Omnigraph query response missing or malformed graphCommitId"),
                }),
              ),
            )
            .exhaustive()
        })
        .with({ _tag: "None" }, () =>
          Effect.fail(
            new WorkflowProjectorCallError({
              cause: new Error("Omnigraph query response missing or malformed rows envelope"),
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
): Effect.fn.Return<
  {
    readonly targetState: WorkflowProjectionTargetState
    readonly graphCommitId: OmnigraphCommitId
  },
  WorkflowProjectorCallError
> {
  const emptyEnvelope: {
    readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>
    readonly graphCommitId: OmnigraphCommitId | undefined
  } = {
    rows: [],
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
  ].filter((id): id is OmnigraphCommitId => id !== undefined)

  const commitId = observedCommitIds[0]
  if (commitId === undefined) {
    return yield* new WorkflowProjectorCallError({
      cause: new Error("Missing graphCommitId during snapshot read"),
    })
  }
  if (observedCommitIds.some((id) => id !== commitId)) {
    return yield* new WorkflowProjectorCallError({
      cause: Object.assign(new Error("Concurrent graph commit detected during snapshot read"), {
        status: 412,
      }),
    })
  }

  const droppedByKind = new Map<string, number>()

  const existingRuns = decodeRowsOrCountDropped(
    "WorkflowRun",
    runRes.rows,
    (row) => decodeExistingRunOption(row),
    droppedByKind,
  )
  const existingRun: ExistingProjectedRun | undefined = existingRuns[0]

  const existingUnits = decodeRowsOrCountDropped(
    "WorkUnit",
    unitsRes.rows,
    (row) =>
      decodeExistingUnitOption({
        ...row,
        waveIndex: parseFiniteNumberOrString(row.waveIndex),
      }),
    droppedByKind,
  )

  const existingAttempts = decodeRowsOrCountDropped(
    "UnitAttempt",
    attemptsRes.rows,
    (row) =>
      decodeExistingAttemptOption({
        ...row,
        attempt: parseFiniteNumberOrString(row.attempt),
        runner: row.runner ?? null,
        rejection: row.rejection ?? null,
        packageStampHash: row.packageStampHash ?? null,
      }),
    droppedByKind,
  )

  const decodeEdgeRows = (
    edgeType: ProjectedEdgeType,
    rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ): ReadonlyArray<ExistingProjectedEdge> =>
    decodeRowsOrCountDropped(
      edgeType,
      rows,
      (row) =>
        decodeExistingEdgeOption({
          edgeType,
          from: row.from,
          to: row.to,
          role: row.role,
          archimateRelation: row.archimateRelation,
        }),
      droppedByKind,
    )

  const existingEdges: ReadonlyArray<ExistingProjectedEdge> = [
    ...decodeEdgeRows("PlaysRunUnitRole", runUnitEdgesRes.rows),
    ...decodeEdgeRows("PlaysUnitAttemptRole", unitAttemptEdgesRes.rows),
    ...decodeEdgeRows("PlaysUnitStubRole", unitStubEdgesRes.rows),
    ...decodeEdgeRows("PlaysUnitEarsRole", unitEarsEdgesRes.rows),
    ...decodeEdgeRows("PlaysUnitTraceabilityRole", unitTraceEdgesRes.rows),
    ...decodeEdgeRows("PlaysAttemptTestRole", attemptTestEdgesRes.rows),
  ]

  const exercisingRows = decodeRowsOrCountDropped(
    "ExercisingTest",
    exercisingRes.rows,
    (row) => decodeExercisingTestRowOption(row),
    droppedByKind,
  )
  const exercisingTestsByFn = new Map<string, Array<string>>()
  for (const row of exercisingRows) {
    const list = exercisingTestsByFn.get(row.qualname)
    if (list !== undefined) {
      list.push(row.testId)
    } else {
      exercisingTestsByFn.set(row.qualname, [row.testId])
    }
  }

  const effectFns: Array<ProjectedEffectFn> = decodeRowsOrCountDropped(
    "EffectFn",
    effectFnsRes.rows,
    (row) =>
      Option.map(decodeEffectFnRowOption(row), (parsed) => ({
        qualname: parsed.qualname,
        spanName: parsed.spanName,
        file: parsed.file,
        isStub: parsed.isStub === true,
        exercisingTestIds: exercisingTestsByFn.get(parsed.qualname),
      })),
    droppedByKind,
  )

  const earsSpecs: Array<ProjectedEarsSpec> = decodeRowsOrCountDropped(
    "EarsSpec",
    earsSpecsRes.rows,
    (row) => decodeEarsSpecRowOption(row),
    droppedByKind,
  )

  const traceabilityTuples: Array<ProjectedTraceabilityTuple> = decodeRowsOrCountDropped(
    "TraceabilityTuple",
    traceTuplesRes.rows,
    (row) =>
      Option.map(decodeTraceabilityTupleRowOption(row), (parsed) => ({
        relationId: parsed.relationId,
        earsSpecId: parsed.earsSpecId ?? null,
        targetSymbolQualname: parsed.targetSymbolQualname,
      })),
    droppedByKind,
  )

  const vitestCases: Array<ProjectedVitestCase> = decodeRowsOrCountDropped(
    "VitestCase",
    vitestCasesRes.rows,
    (row) => decodeVitestCaseRowOption(row),
    droppedByKind,
  )

  if (droppedByKind.size > 0) {
    const summary = [...droppedByKind.entries()]
      .map(([kind, count]) => `${kind}: ${count}`)
      .join(", ")
    return yield* new WorkflowProjectorCallError({
      cause: new Error(`Malformed graph rows dropped during snapshot read (${summary})`),
    })
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
