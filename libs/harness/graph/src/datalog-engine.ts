import { Effect } from "effect"
import { runGraphInferencePipeline } from "./datalog/stratum-3-completion-and-holes.js"
import {
  type HarnessGraph,
  type SemanticEdgePriors,
} from "./model.js"

export {
  STANDARD_DATALOG_RULES,
  minHeightReducer,
  flixConfidenceReducer,
  isAggregateFnNode,
  type FlixConfidenceLatticeElement,
} from "./datalog/datalog-types-and-semiring.js"

export {
  runStratum1And2,
  reconstructCallWitnessPath,
  findShortestLayerCycle,
  type Stratum1And2Result,
} from "./datalog/stratum-1-and-2-rules.js"

export {
  runStratum3CompletionAndHoles,
  runGraphInferencePipeline,
} from "./datalog/stratum-3-completion-and-holes.js"

export {
  DatalogSession,
  stepDatalogFileDelta,
  datalogSessionLive,
  normalizeWorkspacePath,
  type DatalogSessionShape,
  type DatalogSessionSnapshot,
  type DatalogFileDeltaStepInput,
} from "./datalog/datalog-session.js"

/**
 * Pure 4-stratum Differential Dataflow / Stratified Datalog decider (`GraphInfer.decide`, `R = never`).
 */
export const decideGraphInference = Effect.fn("GraphInfer.decide")(function* (
  harnessGraph: HarnessGraph,
  priors?: SemanticEdgePriors,
) {
  return yield* runGraphInferencePipeline(harnessGraph, priors)
})
