import { Effect } from "effect"
import { runGraphInferencePipeline } from "./datalog/stratum-3-completion-and-holes.js"
import {
  type HarnessGraph,
  type SemanticEdgePriors,
} from "./model.js"

export * from "./datalog/datalog-types-and-semiring.js"
export * from "./datalog/stratum-1-and-2-rules.js"
export * from "./datalog/stratum-3-completion-and-holes.js"
export * from "./datalog/datalog-session.js"

/**
 * Pure 4-stratum Differential Dataflow / Stratified Datalog decider (`GraphInfer.decide`, `R = never`).
 */
export const decideGraphInference = Effect.fn("GraphInfer.decide")(function* (
  harnessGraph: HarnessGraph,
  priors?: SemanticEdgePriors,
) {
  return yield* runGraphInferencePipeline(harnessGraph, priors)
})
