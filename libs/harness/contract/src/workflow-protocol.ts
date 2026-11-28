import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { ErrorReasonMessage } from "./workspace-and-process.js"
import { AttemptNumber, EscalationOrdinal, ShipStage, WaveIndex, WorkUnitId } from "./workflow.js"
import { PendingDeferredName } from "./workflow-rpc.js"
import { decodeShipAttemptKey, encodeShipAttemptKey } from "./workflow-ship.js"

export { decodeShipAttemptKey, encodeShipAttemptKey }

/** Branded persisted workflow activity name stored inside Effect Workflow journal rows. */
export const WorkflowActivityName = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("WorkflowActivityName"),
)
export type WorkflowActivityName = typeof WorkflowActivityName.Type

/** Target subtype for `ProjectRunAborted` activity tags. */
export const WorkflowRunAbortTarget = Schema.TaggedUnion({
  Unit: { unitId: WorkUnitId, escalationOrdinal: EscalationOrdinal },
  Merge: { waveIndex: WaveIndex, escalationOrdinal: EscalationOrdinal },
})
export type WorkflowRunAbortTarget = typeof WorkflowRunAbortTarget.Type

/** Closed 20-variant union of canonical `HarnessTaskWorkflow` and `ShipWorkflow` activity names. */
export const WorkflowActivityTag = Schema.TaggedUnion({
  ProvisionWorktrees: {},
  ProjectRunStarted: {},
  ProjectRunWaitingLlmPhase: {},
  ProjectRunCompleted: {},
  ProjectWaveToHarness: { waveIndex: WaveIndex },
  RouteReview: {},
  RunGate: { stage: ShipStage },
  ProjectRunAborted: { target: WorkflowRunAbortTarget },
  MergeSliceWave: { waveIndex: WaveIndex, escalationOrdinal: EscalationOrdinal },
  ProjectWaveMergeEscalated: { waveIndex: WaveIndex, escalationOrdinal: EscalationOrdinal },
  ProjectWaveMergeRetried: { waveIndex: WaveIndex, escalationOrdinal: EscalationOrdinal },
  ProjectUnitDispatched: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  },
  ProjectUnitCompleted: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  },
  ProjectUnitRejected: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  },
  ProjectUnitAttemptEscalated: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  },
  DispatchUnitAgent: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  },
  VerifyUnit: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  },
  ProjectUnitEscalated: { unitId: WorkUnitId, escalationOrdinal: EscalationOrdinal },
  ProjectUnitEscalationRetried: { unitId: WorkUnitId, escalationOrdinal: EscalationOrdinal },
  VerifySharedStep: { attempt: AttemptNumber, escalationOrdinal: EscalationOrdinal },
})
export type WorkflowActivityTag = typeof WorkflowActivityTag.Type

/** Closed 4-variant union of canonical `HarnessTaskWorkflow` durable deferred names. */
export const WorkflowDeferredTag = Schema.TaggedUnion({
  LlmPhaseDone: {},
  InterruptSignal: {},
  UnitCompletion: {
    unitId: WorkUnitId,
    attempt: AttemptNumber,
    escalationOrdinal: EscalationOrdinal,
  },
  UnitEscalation: { unitId: WorkUnitId, escalationOrdinal: EscalationOrdinal },
})
export type WorkflowDeferredTag = typeof WorkflowDeferredTag.Type

const cycleSuffix = (escalationOrdinal: EscalationOrdinal): string =>
  escalationOrdinal === 1 ? "" : `/r${escalationOrdinal}`

/** Encodes a `WorkflowActivityTag` into its canonical wire `WorkflowActivityName`. */
export const encodeWorkflowActivityName = (tag: WorkflowActivityTag): WorkflowActivityName =>
  match(tag)
    .with(
      { _tag: "ProvisionWorktrees" },
      { _tag: "ProjectRunStarted" },
      { _tag: "ProjectRunWaitingLlmPhase" },
      { _tag: "ProjectRunCompleted" },
      { _tag: "RouteReview" },
      (t) => WorkflowActivityName.make(t._tag),
    )
    .with({ _tag: "ProjectRunAborted" }, ({ target }) =>
      match(target)
        .with({ _tag: "Unit" }, ({ unitId, escalationOrdinal }) =>
          WorkflowActivityName.make(`ProjectRunAborted/${unitId}/${escalationOrdinal}`),
        )
        .with({ _tag: "Merge" }, ({ waveIndex, escalationOrdinal }) =>
          WorkflowActivityName.make(`ProjectRunAborted/merge/${waveIndex}/${escalationOrdinal}`),
        )
        .exhaustive(),
    )
    .with({ _tag: "ProjectWaveToHarness" }, ({ waveIndex }) =>
      WorkflowActivityName.make(`ProjectWaveToHarness/${waveIndex}`),
    )
    .with({ _tag: "MergeSliceWave" }, ({ waveIndex, escalationOrdinal }) =>
      WorkflowActivityName.make(`MergeSliceWave/${waveIndex}${cycleSuffix(escalationOrdinal)}`),
    )
    .with({ _tag: "ProjectWaveMergeEscalated" }, ({ waveIndex, escalationOrdinal }) =>
      WorkflowActivityName.make(`ProjectWaveMergeEscalated/${waveIndex}/${escalationOrdinal}`),
    )
    .with({ _tag: "ProjectWaveMergeRetried" }, ({ waveIndex, escalationOrdinal }) =>
      WorkflowActivityName.make(`ProjectWaveMergeRetried/${waveIndex}/${escalationOrdinal}`),
    )
    .with(
      { _tag: "ProjectUnitDispatched" },
      { _tag: "ProjectUnitCompleted" },
      { _tag: "ProjectUnitRejected" },
      { _tag: "ProjectUnitAttemptEscalated" },
      { _tag: "DispatchUnitAgent" },
      { _tag: "VerifyUnit" },
      (t) =>
        WorkflowActivityName.make(
          `${t._tag}/${t.unitId}/${t.attempt}${cycleSuffix(t.escalationOrdinal)}`,
        ),
    )
    .with({ _tag: "ProjectUnitEscalated" }, { _tag: "ProjectUnitEscalationRetried" }, (t) =>
      WorkflowActivityName.make(`${t._tag}/${t.unitId}/${t.escalationOrdinal}`),
    )
    .with({ _tag: "VerifySharedStep" }, ({ attempt, escalationOrdinal }) =>
      WorkflowActivityName.make(`VerifySharedStep/${attempt}${cycleSuffix(escalationOrdinal)}`),
    )
    .with({ _tag: "RunGate" }, ({ stage }) => WorkflowActivityName.make(`RunGate/${stage}`))
    .exhaustive()

/** Encodes a `WorkflowDeferredTag` into its canonical wire `PendingDeferredName`. */
export const encodeWorkflowDeferredName = (tag: WorkflowDeferredTag): PendingDeferredName =>
  match(tag)
    .with({ _tag: "LlmPhaseDone" }, () => PendingDeferredName.make("llm-phase-done"))
    .with({ _tag: "InterruptSignal" }, () => PendingDeferredName.make("Workflow/InterruptSignal"))
    .with({ _tag: "UnitCompletion" }, ({ unitId, attempt, escalationOrdinal }) =>
      PendingDeferredName.make(`unit/${unitId}/${attempt}${cycleSuffix(escalationOrdinal)}`),
    )
    .with({ _tag: "UnitEscalation" }, ({ unitId, escalationOrdinal }) =>
      PendingDeferredName.make(`escalation/${unitId}/${escalationOrdinal}`),
    )
    .exhaustive()

const POSITIVE_INT_SEGMENT_RE = /^[1-9]\d*$/
const NON_NEGATIVE_INT_SEGMENT_RE = /^(?:0|[1-9]\d*)$/
const decodeAttemptNumberOption = Schema.decodeUnknownOption(AttemptNumber)
const decodeEscalationOrdinalOption = Schema.decodeUnknownOption(EscalationOrdinal)
const decodeShipStageOption = Schema.decodeUnknownOption(ShipStage)
const decodeWaveIndexOption = Schema.decodeUnknownOption(WaveIndex)
const decodeWorkUnitIdOption = Schema.decodeUnknownOption(WorkUnitId)

const parseSafeInt = (rawDigits: string, pattern: RegExp): number | undefined => {
  if (!pattern.test(rawDigits)) {
    return undefined
  }
  const parsed = Number(rawDigits)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const parseAttemptSegment = (seg: string): AttemptNumber | undefined => {
  const n = parseSafeInt(seg, POSITIVE_INT_SEGMENT_RE)
  if (n === undefined) {
    return undefined
  }
  return match(decodeAttemptNumberOption(n))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

const parseEscalationOrdinalSegment = (seg: string): EscalationOrdinal | undefined => {
  const n = parseSafeInt(seg, POSITIVE_INT_SEGMENT_RE)
  if (n === undefined) {
    return undefined
  }
  return match(decodeEscalationOrdinalOption(n))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

const parseCycleSuffixOrdinal = (seg: string | undefined): EscalationOrdinal | undefined => {
  if (seg === undefined) {
    return EscalationOrdinal.make(1)
  }
  if (!seg.startsWith("r")) {
    return undefined
  }
  const parsed = parseEscalationOrdinalSegment(seg.slice(1))
  return parsed !== undefined && parsed >= 2 ? parsed : undefined
}

const parseWaveIndexSegment = (seg: string): WaveIndex | undefined => {
  const n = parseSafeInt(seg, NON_NEGATIVE_INT_SEGMENT_RE)
  if (n === undefined) {
    return undefined
  }
  return match(decodeWaveIndexOption(n))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()
}

const parseWorkUnitIdSegment = (seg: string): WorkUnitId | undefined =>
  match(decodeWorkUnitIdOption(seg))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

const failProtocol = (
  kind: "activity" | "deferred",
  raw: string,
  detail: string,
): Result.Result<never, ErrorReasonMessage> =>
  Result.fail(ErrorReasonMessage.make(`Invalid workflow ${kind} name '${raw}': ${detail}`))

const parsePairSegments = <A, B>(
  segs: ReadonlyArray<string>,
  parseFirst: (seg: string) => A | undefined,
  parseSecond: (seg: string) => B | undefined,
): readonly [A, B] | undefined => {
  if (segs.length !== 3) {
    return undefined
  }
  const first = parseFirst(segs[1]!)
  const second = parseSecond(segs[2]!)
  return first !== undefined && second !== undefined ? [first, second] : undefined
}

const parseUnitCycleSegments = (
  segs: ReadonlyArray<string>,
):
  | {
      readonly unitId: WorkUnitId
      readonly attempt: AttemptNumber
      readonly escalationOrdinal: EscalationOrdinal
    }
  | undefined => {
  if (segs.length < 3 || segs.length > 4) {
    return undefined
  }
  const unitId = parseWorkUnitIdSegment(segs[1]!)
  const attempt = parseAttemptSegment(segs[2]!)
  const escalationOrdinal = parseCycleSuffixOrdinal(segs[3])
  return unitId !== undefined && attempt !== undefined && escalationOrdinal !== undefined
    ? { unitId, attempt, escalationOrdinal }
    : undefined
}

type ActivitySegmentDecoder = (
  raw: string,
  segs: ReadonlyArray<string>,
) => Result.Result<WorkflowActivityTag, ErrorReasonMessage>

const makeZeroArgActivityDecoder =
  (build: () => WorkflowActivityTag): ActivitySegmentDecoder =>
  (raw, segs) =>
    segs.length === 1 ? Result.succeed(build()) : failProtocol("activity", raw, "extra segments")

const makeUnitAttemptActivityDecoder =
  (
    tagName: string,
    build: (args: {
      readonly unitId: WorkUnitId
      readonly attempt: AttemptNumber
      readonly escalationOrdinal: EscalationOrdinal
    }) => WorkflowActivityTag,
  ): ActivitySegmentDecoder =>
  (raw, segs) => {
    const args = parseUnitCycleSegments(segs)
    return args !== undefined
      ? Result.succeed(build(args))
      : failProtocol("activity", raw, `invalid ${tagName} identifiers`)
  }

const makeUnitEscalationActivityDecoder =
  (
    tagName: string,
    build: (unitId: WorkUnitId, escalationOrdinal: EscalationOrdinal) => WorkflowActivityTag,
  ): ActivitySegmentDecoder =>
  (raw, segs) => {
    const pair = parsePairSegments(segs, parseWorkUnitIdSegment, parseEscalationOrdinalSegment)
    return pair !== undefined
      ? Result.succeed(build(pair[0], pair[1]))
      : failProtocol("activity", raw, `invalid ${tagName} identifiers`)
  }

const makeWaveEscalationActivityDecoder =
  (
    tagName: string,
    build: (waveIndex: WaveIndex, escalationOrdinal: EscalationOrdinal) => WorkflowActivityTag,
  ): ActivitySegmentDecoder =>
  (raw, segs) => {
    const pair = parsePairSegments(segs, parseWaveIndexSegment, parseEscalationOrdinalSegment)
    return pair !== undefined
      ? Result.succeed(build(pair[0], pair[1]))
      : failProtocol("activity", raw, `invalid ${tagName} identifiers`)
  }

/** Compile-time exhaustive activity decoder dispatch table tied directly to `WorkflowActivityTag["_tag"]`. */
export const WORKFLOW_ACTIVITY_DECODERS = {
  ProvisionWorktrees: makeZeroArgActivityDecoder(() =>
    WorkflowActivityTag.cases.ProvisionWorktrees.make({}),
  ),
  ProjectRunStarted: makeZeroArgActivityDecoder(() =>
    WorkflowActivityTag.cases.ProjectRunStarted.make({}),
  ),
  ProjectRunWaitingLlmPhase: makeZeroArgActivityDecoder(() =>
    WorkflowActivityTag.cases.ProjectRunWaitingLlmPhase.make({}),
  ),
  ProjectRunCompleted: makeZeroArgActivityDecoder(() =>
    WorkflowActivityTag.cases.ProjectRunCompleted.make({}),
  ),
  ProjectWaveToHarness: (raw, segs) => {
    if (segs.length !== 2) {
      return failProtocol("activity", raw, "invalid ProjectWaveToHarness segment count")
    }
    const waveIndex = parseWaveIndexSegment(segs[1]!)
    return waveIndex !== undefined
      ? Result.succeed(WorkflowActivityTag.cases.ProjectWaveToHarness.make({ waveIndex }))
      : failProtocol("activity", raw, "invalid ProjectWaveToHarness waveIndex")
  },
  RouteReview: makeZeroArgActivityDecoder(() => WorkflowActivityTag.cases.RouteReview.make({})),
  RunGate: (raw, segs) => {
    if (segs.length !== 2) {
      return failProtocol("activity", raw, "invalid RunGate segment count")
    }
    return match(decodeShipStageOption(segs[1]!))
      .with({ _tag: "Some" }, ({ value: stage }) =>
        Result.succeed(WorkflowActivityTag.cases.RunGate.make({ stage })),
      )
      .with({ _tag: "None" }, () => failProtocol("activity", raw, "invalid RunGate stage"))
      .exhaustive()
  },
  ProjectRunAborted: (raw, segs) => {
    if (segs.length === 4 && segs[1] === "merge") {
      const waveIndex = parseWaveIndexSegment(segs[2]!)
      const escalationOrdinal = parseEscalationOrdinalSegment(segs[3]!)
      return waveIndex !== undefined && escalationOrdinal !== undefined
        ? Result.succeed(
            WorkflowActivityTag.cases.ProjectRunAborted.make({
              target: WorkflowRunAbortTarget.cases.Merge.make({ waveIndex, escalationOrdinal }),
            }),
          )
        : failProtocol("activity", raw, "invalid merge abort identifiers")
    }
    const pair = parsePairSegments(segs, parseWorkUnitIdSegment, parseEscalationOrdinalSegment)
    return pair !== undefined
      ? Result.succeed(
          WorkflowActivityTag.cases.ProjectRunAborted.make({
            target: WorkflowRunAbortTarget.cases.Unit.make({
              unitId: pair[0],
              escalationOrdinal: pair[1],
            }),
          }),
        )
      : failProtocol("activity", raw, "invalid abort identifiers")
  },
  MergeSliceWave: (raw, segs) => {
    if (segs.length < 2 || segs.length > 3) {
      return failProtocol("activity", raw, "invalid MergeSliceWave segment count")
    }
    const escalationOrdinal = parseCycleSuffixOrdinal(segs[2])
    const waveIndex = parseWaveIndexSegment(segs[1]!)
    return waveIndex !== undefined && escalationOrdinal !== undefined
      ? Result.succeed(
          WorkflowActivityTag.cases.MergeSliceWave.make({ waveIndex, escalationOrdinal }),
        )
      : failProtocol("activity", raw, "invalid MergeSliceWave identifiers")
  },
  ProjectWaveMergeEscalated: makeWaveEscalationActivityDecoder(
    "ProjectWaveMergeEscalated",
    (waveIndex, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectWaveMergeEscalated.make({ waveIndex, escalationOrdinal }),
  ),
  ProjectWaveMergeRetried: makeWaveEscalationActivityDecoder(
    "ProjectWaveMergeRetried",
    (waveIndex, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectWaveMergeRetried.make({ waveIndex, escalationOrdinal }),
  ),
  ProjectUnitDispatched: makeUnitAttemptActivityDecoder("ProjectUnitDispatched", (args) =>
    WorkflowActivityTag.cases.ProjectUnitDispatched.make(args),
  ),
  ProjectUnitCompleted: makeUnitAttemptActivityDecoder("ProjectUnitCompleted", (args) =>
    WorkflowActivityTag.cases.ProjectUnitCompleted.make(args),
  ),
  ProjectUnitRejected: makeUnitAttemptActivityDecoder("ProjectUnitRejected", (args) =>
    WorkflowActivityTag.cases.ProjectUnitRejected.make(args),
  ),
  ProjectUnitAttemptEscalated: makeUnitAttemptActivityDecoder(
    "ProjectUnitAttemptEscalated",
    (args) => WorkflowActivityTag.cases.ProjectUnitAttemptEscalated.make(args),
  ),
  DispatchUnitAgent: makeUnitAttemptActivityDecoder("DispatchUnitAgent", (args) =>
    WorkflowActivityTag.cases.DispatchUnitAgent.make(args),
  ),
  VerifyUnit: makeUnitAttemptActivityDecoder("VerifyUnit", (args) =>
    WorkflowActivityTag.cases.VerifyUnit.make(args),
  ),
  ProjectUnitEscalated: makeUnitEscalationActivityDecoder(
    "ProjectUnitEscalated",
    (unitId, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectUnitEscalated.make({ unitId, escalationOrdinal }),
  ),
  ProjectUnitEscalationRetried: makeUnitEscalationActivityDecoder(
    "ProjectUnitEscalationRetried",
    (unitId, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectUnitEscalationRetried.make({ unitId, escalationOrdinal }),
  ),
  VerifySharedStep: (raw, segs) => {
    if (segs.length < 2 || segs.length > 3) {
      return failProtocol("activity", raw, "invalid VerifySharedStep segment count")
    }
    const escalationOrdinal = parseCycleSuffixOrdinal(segs[2])
    const attempt = parseAttemptSegment(segs[1]!)
    return attempt !== undefined && escalationOrdinal !== undefined
      ? Result.succeed(
          WorkflowActivityTag.cases.VerifySharedStep.make({ attempt, escalationOrdinal }),
        )
      : failProtocol("activity", raw, "invalid VerifySharedStep identifiers")
  },
} as const satisfies Readonly<Record<WorkflowActivityTag["_tag"], ActivitySegmentDecoder>>

const WORKFLOW_ACTIVITY_DECODER_MAP: ReadonlyMap<string, ActivitySegmentDecoder> = new Map(
  Object.entries(WORKFLOW_ACTIVITY_DECODERS),
)

/** Strictly decodes a persisted journal activity string into a `WorkflowActivityTag`. */
export const decodeWorkflowActivityName = (
  raw: string,
): Result.Result<WorkflowActivityTag, ErrorReasonMessage> => {
  const segs = raw.split("/")
  const head = segs[0]!
  const decoder = WORKFLOW_ACTIVITY_DECODER_MAP.get(head)
  return decoder !== undefined
    ? decoder(raw, segs)
    : failProtocol("activity", raw, `unrecognized activity prefix '${head}'`)
}

type DeferredWireDecoder = (
  raw: string,
  segs: ReadonlyArray<string>,
) => Result.Result<WorkflowDeferredTag, ErrorReasonMessage> | undefined

/** Compile-time exhaustive deferred decoder table tied directly to `WorkflowDeferredTag["_tag"]`. */
export const WORKFLOW_DEFERRED_DECODERS = {
  LlmPhaseDone: (raw) =>
    raw === "llm-phase-done"
      ? Result.succeed(WorkflowDeferredTag.cases.LlmPhaseDone.make({}))
      : undefined,
  InterruptSignal: (raw) =>
    raw === "Workflow/InterruptSignal"
      ? Result.succeed(WorkflowDeferredTag.cases.InterruptSignal.make({}))
      : undefined,
  UnitCompletion: (raw, segs) => {
    if (segs[0] !== "unit") return undefined
    const args = parseUnitCycleSegments(segs)
    return args !== undefined
      ? Result.succeed(WorkflowDeferredTag.cases.UnitCompletion.make(args))
      : failProtocol("deferred", raw, "invalid unit deferred identifiers")
  },
  UnitEscalation: (raw, segs) => {
    if (segs[0] !== "escalation") return undefined
    const pair = parsePairSegments(segs, parseWorkUnitIdSegment, parseEscalationOrdinalSegment)
    return pair !== undefined
      ? Result.succeed(
          WorkflowDeferredTag.cases.UnitEscalation.make({
            unitId: pair[0],
            escalationOrdinal: pair[1],
          }),
        )
      : failProtocol("deferred", raw, "invalid escalation deferred identifiers")
  },
} as const satisfies Readonly<Record<WorkflowDeferredTag["_tag"], DeferredWireDecoder>>

const WORKFLOW_DEFERRED_DECODER_LIST: ReadonlyArray<DeferredWireDecoder> = Object.values(
  WORKFLOW_DEFERRED_DECODERS,
)

/** Strictly decodes a persisted journal deferred string into a `WorkflowDeferredTag`. */
export const decodeWorkflowDeferredName = (
  raw: string,
): Result.Result<WorkflowDeferredTag, ErrorReasonMessage> => {
  const segs = raw.split("/")
  for (const tryDecode of WORKFLOW_DEFERRED_DECODER_LIST) {
    const matched = tryDecode(raw, segs)
    if (matched !== undefined) {
      return matched
    }
  }
  return failProtocol("deferred", raw, `unrecognized deferred name '${raw}'`)
}
