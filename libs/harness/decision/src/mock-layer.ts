import type { DstHazardRiskLevel, EarsGuardPairRelation } from "@harness/gates"
import { Effect, Layer } from "effect"
import * as AiError from "effect/ai/AiError"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match, P } from "ts-pattern"
import type { DpoCohesionLevel, DpoRepairStrategy } from "./dpo-ranker-decision.js"
import type { HoleRelevanceLevel } from "./hole-prior-decision.js"
import type { IdiomBlock } from "./idiom-router.js"
import type { LearnTarget } from "./learn-decision.js"
import type { OntologyConflictKind } from "./ontology-conflict-decision.js"
import type { PlanSearchCohesionLevel } from "./plan-search-decision.js"
import type { RuleGeneralityLevel } from "./rule-quality-decision.js"

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
  readonly edgeConfidenceProb?: number | undefined
  readonly candidateRelevanceLabel?: HoleRelevanceLevel | undefined
  readonly dpoStrategyLabel?: DpoRepairStrategy | undefined
  readonly dpoCohesionLabel?: DpoCohesionLevel | undefined
  readonly earsStateVariantLabel?: string | undefined
  readonly earsGuardVariantLabel?: string | undefined
  readonly earsGuardRelationLabel?: EarsGuardPairRelation | undefined
  readonly dstHazardRiskLabel?: DstHazardRiskLevel | undefined
  readonly mutantEquivalentProb?: number | undefined
  readonly ruleGeneralityLabel?: RuleGeneralityLevel | undefined
  readonly ruleNonTautologicalProb?: number | undefined
  readonly planSearchCohesionLabel?: PlanSearchCohesionLevel | undefined
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
            answers[key] = match(decision)
              .with({ _tag: "Probability" }, (): DecisionModel.ProviderAnswer => {
                const probability = match(key)
                  .with("implemented", () => overrides?.implementedProb ?? 0.9)
                  .with("noOutOfScopeEdits", () => overrides?.noOutOfScopeProb ?? 0.9)
                  .with("fitsAny", () => overrides?.fitsAnyProb ?? 0.9)
                  .with("destructive", () => overrides?.destructiveProb ?? 0.0)
                  .with("secretAccess", () => overrides?.secretAccessProb ?? 0.0)
                  .with("exfiltration", () => overrides?.exfiltrationProb ?? 0.0)
                  .with("actionable", () => overrides?.learnActionableProb ?? 0.9)
                  .with("contradicts", () => overrides?.contradictsProb ?? 0.1)
                  .with(
                    P.when((k) => k === "edgeConfidence" || k.startsWith("edgeConfidence_")),
                    () => overrides?.edgeConfidenceProb ?? 0.92,
                  )
                  .with("isEquivalent", () => overrides?.mutantEquivalentProb ?? 0.1)
                  .with("isNonTautological", () => overrides?.ruleNonTautologicalProb ?? 0.9)
                  .otherwise(() => 0.5)
                return {
                  _tag: "Probability",
                  probability,
                }
              })
              .with({ _tag: "Classify" }, (classifyDec): DecisionModel.ProviderAnswer => {
                const labels = Object.keys(classifyDec.criteria)
                const defaultLabel = labels[0] ?? ""
                const rawChosen = match(key)
                  .with("block", () => overrides?.blockLabel ?? (labels.includes("effect") ? "effect" : defaultLabel))
                  .with("kind", () => overrides?.triageKind ?? (labels.includes("semantic") ? "semantic" : defaultLabel))
                  .with(
                    "target",
                    () =>
                      overrides?.learnTargetLabel ??
                      (labels.includes("agent-pattern") ? "agent-pattern" : defaultLabel),
                  )
                  .with(
                    "conflictKind",
                    () => overrides?.conflictKindLabel ?? (labels.includes("none") ? "none" : defaultLabel),
                  )
                  .with(
                    P.when((k) => k === "repairStrategy" || k.startsWith("repairStrategy_")),
                    () =>
                      overrides?.dpoStrategyLabel ??
                      (labels.includes("propagate_in_E") ? "propagate_in_E" : defaultLabel),
                  )
                  .with(
                    "activeStateVariant",
                    () => overrides?.earsStateVariantLabel ?? (labels.includes("Active") ? "Active" : defaultLabel),
                  )
                  .with(
                    "activeGuardVariant",
                    () => overrides?.earsGuardVariantLabel ?? (labels.includes("Guarded") ? "Guarded" : defaultLabel),
                  )
                  .with(
                    "guardPairRelation",
                    () =>
                      overrides?.earsGuardRelationLabel ??
                      (labels.includes("mutually_exclusive") ? "mutually_exclusive" : defaultLabel),
                  )
                  .otherwise(() => defaultLabel)

                const chosenLabel = labels.includes(rawChosen) ? rawChosen : defaultLabel
                const probabilities: Record<string, number> = {}
                for (const l of labels) {
                  probabilities[l] = l === chosenLabel ? 1 : 0
                }
                return {
                  _tag: "Classify",
                  label: chosenLabel,
                  probabilities,
                }
              })
              .with({ _tag: "Rate" }, (rateDec): DecisionModel.ProviderAnswer => {
                const labels = rateDec.criteria
                const defaultLabel = labels[0] ?? ""
                const rawChosen = match(key)
                  .with(
                    P.when(
                      (k) => k === "architecturalCohesion" || k.startsWith("architecturalCohesion_"),
                    ),
                    () =>
                      overrides?.dpoCohesionLabel ??
                      (labels.includes("idiomatic") ? "idiomatic" : defaultLabel),
                  )
                  .with(
                    "concurrencyRisk",
                    () =>
                      overrides?.dstHazardRiskLabel ??
                      (labels.includes("stateful_mutation") ? "stateful_mutation" : defaultLabel),
                  )
                  .with(
                    "ruleGenerality",
                    () =>
                      overrides?.ruleGeneralityLabel ??
                      (labels.includes("reusable_idiom") ? "reusable_idiom" : defaultLabel),
                  )
                  .with(
                    "decompositionCohesion",
                    () =>
                      overrides?.planSearchCohesionLabel ??
                      (labels.includes("modular") ? "modular" : defaultLabel),
                  )
                  .otherwise(
                    () =>
                      overrides?.candidateRelevanceLabel ??
                      (labels.includes("essential") ? "essential" : defaultLabel),
                  )

                const chosenLabel = labels.includes(rawChosen) ? rawChosen : defaultLabel
                const rating = Math.max(0, labels.indexOf(chosenLabel))
                const probabilities: Record<string, number> = {}
                for (const l of labels) {
                  probabilities[l] = l === chosenLabel ? 1 : 0
                }
                return {
                  _tag: "Rate",
                  rating,
                  probabilities,
                }
              })
              .exhaustive()
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

export const makeFailingDecisionModel = (
  description = "Ollama unreachable",
): Effect.Effect<DecisionModel.DecisionModel> =>
  DecisionModel.make({
    decide: () =>
      Effect.fail(
        AiError.make({
          module: "DecisionModel",
          method: "decide",
          reason: new AiError.UnknownError({ description }),
        }),
      ),
  })

export const makeFailingDecisionModelLayer = (
  description = "Ollama unreachable",
): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    makeFailingDecisionModel(description),
  )
