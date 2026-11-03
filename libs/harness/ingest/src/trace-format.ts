import { Schema } from "effect"

export const TRACE_FORMAT_VERSION = 2

export const TraceHeader = Schema.Struct({
  kind: Schema.Literal("header"),
  version: Schema.Literal(2),
  language: Schema.String,
  repo_root: Schema.String,
  tracer: Schema.String,
  sampled: Schema.Boolean,
})
export type TraceHeader = typeof TraceHeader.Type

export const TracedCallEdge = Schema.Struct({
  callerQualname: Schema.String,
  calleeQualname: Schema.String,
  callCount: Schema.Int,
  receiverLayer: Schema.NullOr(Schema.String),
})
export type TracedCallEdge = typeof TracedCallEdge.Type

export const ExercisesSpanEdge = Schema.Struct({
  testId: Schema.String,
  calleeQualname: Schema.String,
  callCount: Schema.Int,
  receiverLayer: Schema.NullOr(Schema.String),
})
export type ExercisesSpanEdge = typeof ExercisesSpanEdge.Type

export const makeTraceHeader = (repoRoot: string): TraceHeader => ({
  kind: "header",
  version: TRACE_FORMAT_VERSION,
  language: "javascript",
  repo_root: repoRoot,
  tracer: "effect-span",
  sampled: false,
})
