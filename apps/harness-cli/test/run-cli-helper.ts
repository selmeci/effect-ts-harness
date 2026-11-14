import { Effect, type Layer } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { runCliEffect, type CliEnv, type CliResult } from "../src/index.js"

export const runCli = (
  argv: ReadonlyArray<string>,
  options?: CliEnv,
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Promise<CliResult> => Effect.runPromise(runCliEffect(argv, options, maybeDecisionLayer))
