import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { ErrorReasonMessage } from "./workspace-and-process.js"
import { AttemptNumber, EscalationOrdinal, WaveIndex, WorkUnitId } from "./workflow.js"
import { PendingDeferredName } from "./workflow-rpc.js"

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

/** Closed 18-variant union of canonical `HarnessTaskWorkflow` activity names. */
export const WorkflowActivityTag = Schema.TaggedUnion({
  ProvisionWorktrees: {},
  ProjectRunStarted: {},
  ProjectRunWaitingLlmPhase: {},
  ProjectRunCompleted: {},
  RouteReview: {},
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

const ATTEMPT_SEGMENT_RE = /^[1-3]$/
const POSITIVE_INT_SEGMENT_RE = /^[1-9]\d*$/
const NON_NEGATIVE_INT_SEGMENT_RE = /^(?:0|[1-9]\d*)$/
const decodeWorkUnitIdOption = Schema.decodeUnknownOption(WorkUnitId)

const parseSafeInt = (rawDigits: string, pattern: RegExp): number | undefined => {
  if (!pattern.test(rawDigits)) {
    return undefined
  }
  const parsed = Number(rawDigits)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const parseAttemptSegment = (seg: string): AttemptNumber | undefined => {
  const n = parseSafeInt(seg, ATTEMPT_SEGMENT_RE)
  return n !== undefined ? AttemptNumber.make(n) : undefined
}

const parseEscalationOrdinalSegment = (seg: string): EscalationOrdinal | undefined => {
  const n = parseSafeInt(seg, POSITIVE_INT_SEGMENT_RE)
  return n !== undefined ? EscalationOrdinal.make(n) : undefined
}

const parseCycleSuffixOrdinal = (seg: string | undefined): EscalationOrdinal | undefined => {
  if (seg === undefined) {
    return EscalationOrdinal.make(1)
  }
  if (!seg.startsWith("r")) {
    return undefined
  }
  const n = parseSafeInt(seg.slice(1), POSITIVE_INT_SEGMENT_RE)
  return n !== undefined && n >= 2 ? EscalationOrdinal.make(n) : undefined
}

const parseWaveIndexSegment = (seg: string): WaveIndex | undefined => {
  const n = parseSafeInt(seg, NON_NEGATIVE_INT_SEGMENT_RE)
  return n !== undefined ? WaveIndex.make(n) : undefined
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

const ZERO_ARG_ACTIVITY_FACTORIES = new Map<string, () => WorkflowActivityTag>([
  ["ProvisionWorktrees", () => WorkflowActivityTag.cases.ProvisionWorktrees.make({})],
  ["ProjectRunStarted", () => WorkflowActivityTag.cases.ProjectRunStarted.make({})],
  ["ProjectRunWaitingLlmPhase", () => WorkflowActivityTag.cases.ProjectRunWaitingLlmPhase.make({})],
  ["ProjectRunCompleted", () => WorkflowActivityTag.cases.ProjectRunCompleted.make({})],
  ["RouteReview", () => WorkflowActivityTag.cases.RouteReview.make({})],
])

const UNIT_ATTEMPT_ACTIVITY_FACTORIES = new Map<
  string,
  (args: {
    readonly unitId: WorkUnitId
    readonly attempt: AttemptNumber
    readonly escalationOrdinal: EscalationOrdinal
  }) => WorkflowActivityTag
>([
  ["ProjectUnitDispatched", (args) => WorkflowActivityTag.cases.ProjectUnitDispatched.make(args)],
  ["ProjectUnitCompleted", (args) => WorkflowActivityTag.cases.ProjectUnitCompleted.make(args)],
  ["ProjectUnitRejected", (args) => WorkflowActivityTag.cases.ProjectUnitRejected.make(args)],
  [
    "ProjectUnitAttemptEscalated",
    (args) => WorkflowActivityTag.cases.ProjectUnitAttemptEscalated.make(args),
  ],
  ["DispatchUnitAgent", (args) => WorkflowActivityTag.cases.DispatchUnitAgent.make(args)],
  ["VerifyUnit", (args) => WorkflowActivityTag.cases.VerifyUnit.make(args)],
])

const UNIT_ESCALATION_ACTIVITY_FACTORIES = new Map<
  string,
  (unitId: WorkUnitId, escalationOrdinal: EscalationOrdinal) => WorkflowActivityTag
>([
  [
    "ProjectUnitEscalated",
    (unitId, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectUnitEscalated.make({ unitId, escalationOrdinal }),
  ],
  [
    "ProjectUnitEscalationRetried",
    (unitId, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectUnitEscalationRetried.make({ unitId, escalationOrdinal }),
  ],
])

const WAVE_ESCALATION_ACTIVITY_FACTORIES = new Map<
  string,
  (waveIndex: WaveIndex, escalationOrdinal: EscalationOrdinal) => WorkflowActivityTag
>([
  [
    "ProjectWaveMergeEscalated",
    (waveIndex, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectWaveMergeEscalated.make({ waveIndex, escalationOrdinal }),
  ],
  [
    "ProjectWaveMergeRetried",
    (waveIndex, escalationOrdinal) =>
      WorkflowActivityTag.cases.ProjectWaveMergeRetried.make({ waveIndex, escalationOrdinal }),
  ],
])

/** Strictly decodes a persisted journal activity string into a `WorkflowActivityTag`. */
export const decodeWorkflowActivityName = (
  raw: string,
): Result.Result<WorkflowActivityTag, ErrorReasonMessage> => {
  const segs = raw.split("/")
  const head = segs[0]!
  const zeroFactory = ZERO_ARG_ACTIVITY_FACTORIES.get(head)
  if (zeroFactory !== undefined) {
    return segs.length === 1
      ? Result.succeed(zeroFactory())
      : failProtocol("activity", raw, "extra segments")
  }
  if (head === "ProjectRunAborted") {
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
  }
  if (head === "MergeSliceWave" || head === "VerifySharedStep") {
    if (segs.length < 2 || segs.length > 3) {
      return failProtocol("activity", raw, `invalid ${head} segment count`)
    }
    const escalationOrdinal = parseCycleSuffixOrdinal(segs[2])
    if (head === "MergeSliceWave") {
      const waveIndex = parseWaveIndexSegment(segs[1]!)
      return waveIndex !== undefined && escalationOrdinal !== undefined
        ? Result.succeed(
            WorkflowActivityTag.cases.MergeSliceWave.make({ waveIndex, escalationOrdinal }),
          )
        : failProtocol("activity", raw, "invalid MergeSliceWave identifiers")
    }
    const attempt = parseAttemptSegment(segs[1]!)
    return attempt !== undefined && escalationOrdinal !== undefined
      ? Result.succeed(
          WorkflowActivityTag.cases.VerifySharedStep.make({ attempt, escalationOrdinal }),
        )
      : failProtocol("activity", raw, "invalid VerifySharedStep identifiers")
  }
  const waveFactory = WAVE_ESCALATION_ACTIVITY_FACTORIES.get(head)
  if (waveFactory !== undefined) {
    const pair = parsePairSegments(segs, parseWaveIndexSegment, parseEscalationOrdinalSegment)
    return pair !== undefined
      ? Result.succeed(waveFactory(pair[0], pair[1]))
      : failProtocol("activity", raw, `invalid ${head} identifiers`)
  }
  const unitAttemptFactory = UNIT_ATTEMPT_ACTIVITY_FACTORIES.get(head)
  if (unitAttemptFactory !== undefined) {
    const args = parseUnitCycleSegments(segs)
    return args !== undefined
      ? Result.succeed(unitAttemptFactory(args))
      : failProtocol("activity", raw, `invalid ${head} identifiers`)
  }
  const unitEscFactory = UNIT_ESCALATION_ACTIVITY_FACTORIES.get(head)
  if (unitEscFactory !== undefined) {
    const pair = parsePairSegments(segs, parseWorkUnitIdSegment, parseEscalationOrdinalSegment)
    return pair !== undefined
      ? Result.succeed(unitEscFactory(pair[0], pair[1]))
      : failProtocol("activity", raw, `invalid ${head} identifiers`)
  }
  return failProtocol("activity", raw, `unrecognized activity prefix '${head}'`)
}

/** Strictly decodes a persisted journal deferred string into a `WorkflowDeferredTag`. */
export const decodeWorkflowDeferredName = (
  raw: string,
): Result.Result<WorkflowDeferredTag, ErrorReasonMessage> => {
  if (raw === "llm-phase-done") {
    return Result.succeed(WorkflowDeferredTag.cases.LlmPhaseDone.make({}))
  }
  if (raw === "Workflow/InterruptSignal") {
    return Result.succeed(WorkflowDeferredTag.cases.InterruptSignal.make({}))
  }
  const segs = raw.split("/")
  const head = segs[0]!
  if (head === "unit") {
    const args = parseUnitCycleSegments(segs)
    return args !== undefined
      ? Result.succeed(WorkflowDeferredTag.cases.UnitCompletion.make(args))
      : failProtocol("deferred", raw, "invalid unit deferred identifiers")
  }
  if (head === "escalation") {
    const pair = parsePairSegments(segs, parseWorkUnitIdSegment, parseEscalationOrdinalSegment)
    return pair !== undefined
      ? Result.succeed(
          WorkflowDeferredTag.cases.UnitEscalation.make({
            unitId: pair[0],
            escalationOrdinal: pair[1],
          }),
        )
      : failProtocol("deferred", raw, "invalid escalation deferred identifiers")
  }
  return failProtocol("deferred", raw, `unrecognized deferred name '${raw}'`)
}
