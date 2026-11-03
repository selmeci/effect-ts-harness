import { Effect, Layer } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import type { IdiomBlock } from "./idiom-router.js"
import type { LearnTarget } from "./learn-decision.js"
import type { OntologyConflictKind } from "./ontology-conflict-decision.js"

export interface MockDecisionModelOverrides {
  readonly implementedProb?: number | undefined
  readonly noOutOfScopeProb?: number | undefined
  readonly fitsAnyProb?: number | undefined
  readonly blockLabel?: IdiomBlock | undefined
  readonly destructiveProb?: number | undefined
  readonly secretAccessProb?: number | undefined
  readonly exfiltrationProb?: number | undefined
  readonly triageKind?: "mechanical" | "semantic" | undefined
  readonly learnActionableProb?: number | undefined
  readonly learnTargetLabel?: LearnTarget | undefined
  readonly contradictsProb?: number | undefined
  readonly conflictKindLabel?: OntologyConflictKind | undefined
}

export const makeMockDecisionModelLayer = (
  overrides?: MockDecisionModelOverrides,
): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) =>
        Effect.sync(() => {
          const answers: Record<string, DecisionModel.ProviderAnswer> = {}
          for (const [key, decision] of Object.entries(options.decisions)) {
            if (decision._tag === "Probability") {
              let probability = 0.5
              if (key === "implemented") {
                probability =
                  overrides?.implementedProb !== undefined ? overrides.implementedProb : 0.9
              } else if (key === "noOutOfScopeEdits") {
                probability =
                  overrides?.noOutOfScopeProb !== undefined ? overrides.noOutOfScopeProb : 0.9
              } else if (key === "fitsAny") {
                probability = overrides?.fitsAnyProb !== undefined ? overrides.fitsAnyProb : 0.9
              } else if (key === "destructive") {
                probability =
                  overrides?.destructiveProb !== undefined ? overrides.destructiveProb : 0.0
              } else if (key === "secretAccess") {
                probability =
                  overrides?.secretAccessProb !== undefined ? overrides.secretAccessProb : 0.0
              } else if (key === "exfiltration") {
                probability =
                  overrides?.exfiltrationProb !== undefined ? overrides.exfiltrationProb : 0.0
              } else if (key === "actionable") {
                probability =
                  overrides?.learnActionableProb !== undefined ? overrides.learnActionableProb : 0.9
              } else if (key === "contradicts") {
                probability =
                  overrides?.contradictsProb !== undefined ? overrides.contradictsProb : 0.1
              }
              answers[key] = {
                _tag: "Probability",
                probability,
              }
            } else if (decision._tag === "Classify") {
              const labels = Object.keys(decision.criteria)
              let chosenLabel = labels[0] ?? ""
              if (key === "block") {
                chosenLabel =
                  overrides?.blockLabel ?? (labels.includes("effect") ? "effect" : chosenLabel)
              } else if (key === "kind") {
                chosenLabel =
                  overrides?.triageKind ?? (labels.includes("semantic") ? "semantic" : chosenLabel)
              } else if (key === "target") {
                chosenLabel =
                  overrides?.learnTargetLabel ??
                  (labels.includes("agent-pattern") ? "agent-pattern" : chosenLabel)
              } else if (key === "conflictKind") {
                chosenLabel =
                  overrides?.conflictKindLabel ?? (labels.includes("none") ? "none" : chosenLabel)
              }
              const probabilities: Record<string, number> = {}
              for (const l of labels) {
                probabilities[l] = l === chosenLabel ? 1 : 0
              }
              answers[key] = {
                _tag: "Classify",
                label: chosenLabel,
                probabilities,
              }
            }
          }
          return {
            answers,
            usage: {
              inputTokens: 10,
              outputTokens: 2,
            },
          }
        }),
    }),
  )

export const makeFailingDecisionModelLayer = (
  description = "Ollama unreachable",
): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.fail(
          AiError.make({
            module: "DecisionModel",
            method: "decide",
            reason: new AiError.UnknownError({ description }),
          }),
        ),
    }),
  )
