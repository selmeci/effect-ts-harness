import { Effect, Result } from "effect"
import { match } from "ts-pattern"
import { runGraphInferenceSync } from "./datalog/datalog-session.js"
import { renderMermaid } from "./graph-engine.js"
import {
  type HarnessGraph,
  ViolationRule,
} from "./model.js"
import {
  isAggregateFnNode,
  isCloudBinding,
  isDeciderSpan,
  isEventBusServiceNode,
  isOutboxDrainOrBusPublishFnNode,
  isReducerSpan,
} from "./datalog/datalog-types-and-semiring.js"

export {
  isAggregateFnNode,
  isCloudBinding,
  isDeciderSpan,
  isEventBusServiceNode,
  isOutboxDrainOrBusPublishFnNode,
  isReducerSpan,
}

export interface GraphPolicyViolation {
  readonly rule: ViolationRule
  readonly message: string
  readonly path: ReadonlyArray<string>
}

export interface CheckEffectGraphResult {
  readonly ok: boolean
  readonly violations: ReadonlyArray<GraphPolicyViolation>
  readonly mermaid: string
}

/**
 * Options for configuring architectural policy checks over `HarnessGraph`.
 */
export interface CheckEffectGraphOptions {
  /**
   * When true, includes lifecycle-gated rules:
   * - `missing-layer-provider` (enforced during Layer composition / `gc-check.ts` / `plugins/gc/gc-topology-entropy.plugin.ts`)
   * - `untested-domain-span` (enforced during implementation / `gc-check.ts` / `plugins/gc/gc-test-and-decider.plugin.ts`)
   * - `unverified-migration` (enforced during migration gate / `migration-check.ts`)
   *
   * By default, these rules are gated by task lifecycle phases and excluded from standard policy checks.
   */
  readonly includeLifecycleRules?: boolean
  /**
   * Explicit set of violation rules to evaluate. When specified, overrides default and lifecycle rule sets.
   */
  readonly rules?: ReadonlySet<ViolationRule>
  /**
   * When true, verifies that `harnessGraph.unresolvedReferences` is empty, emitting
   * `unresolved-graph-reference` violations for any dangling hypergraph targets.
   */
  readonly checkUnresolvedReferences?: boolean
}


/**
 * Rules that are gated by specific lifecycle gates (`gc-check.ts`, `migration-check.ts`)
 * rather than the basic architectural policy gate.
 */
export const LIFECYCLE_GATED_RULES: ReadonlySet<ViolationRule> = new Set<ViolationRule>([
  "missing-layer-provider",
  "untested-domain-span",
  "unverified-migration",
])

export const DEFAULT_POLICY_CHECK_RULES: ReadonlySet<ViolationRule> = new Set<ViolationRule>([
  "domain-requires-infra",
  "domain-requires-cloud-binding",
  "impure-decider",
  "impure-reducer",
  "aggregate-direct-bus-publish",
  "layer-cycle",
  "unmapped-spec-symbol",
])

export const evaluateEffectGraphPolicy = (
  harnessGraph: HarnessGraph,
  options?: CheckEffectGraphOptions,
): CheckEffectGraphResult => {
  const violations: Array<GraphPolicyViolation> = []

  const inference = runGraphInferenceSync(harnessGraph)

  const isRuleActive = (rule: ViolationRule): boolean => {
    if (options?.rules !== undefined) {
      return options.rules.has(rule)
    }
    if (LIFECYCLE_GATED_RULES.has(rule)) {
      return options?.includeLifecycleRules === true
    }
    return true
  }

  for (const ap of inference.antiPatterns) {
    if (isRuleActive(ap.ruleId)) {
      violations.push({
        rule: ap.ruleId,
        message: ap.message,
        path: ap.path,
      })
    }
  }

  for (const bv of harnessGraph.branchingViolations ?? []) {
    if (isRuleActive(bv.rule)) {
      violations.push({
        rule: bv.rule,
        message: bv.message,
        path: bv.path ?? [bv.file, bv.enclosingSymbol],
      })
    }
  }

  if (options?.checkUnresolvedReferences === true) {
    for (const ref of harnessGraph.unresolvedReferences ?? []) {
      violations.push({
        rule: "unresolved-graph-reference",
        message: `Unresolved graph reference on relation '${ref.relationId}' role '${ref.role}' targeting '${ref.targetKey}'`,
        path: [ref.relationId, ref.role, ref.targetKey],
      })
    }
  }

  const mermaid = renderMermaid(harnessGraph)

  return {
    ok: violations.length === 0,
    violations,
    mermaid,
  }
}

/**
 * Pure Effect decider (`GraphPolicy.decide`) evaluating architectural graph policies
 * by delegating to `evaluateEffectGraphPolicy`.
 */
export const decideEffectGraphPolicy = Effect.fn("GraphPolicy.decide")(
  (harnessGraph: HarnessGraph, options?: CheckEffectGraphOptions) =>
    Effect.sync(() => evaluateEffectGraphPolicy(harnessGraph, options)),
)

/**
 * Evaluates architectural graph policies over the PERA Levi Hypergraph by delegating
 * to `evaluateEffectGraphPolicy` synchronously without `Effect.runSyncExit`.
 */
export const checkEffectGraph = (
  harnessGraph: HarnessGraph,
  options?: CheckEffectGraphOptions,
): CheckEffectGraphResult => {
  const res = Result.try(() => evaluateEffectGraphPolicy(harnessGraph, options))
  return match(res)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      const failureMsg = failure instanceof Error ? failure.message : String(failure)
      return {
        ok: false,
        violations: [
          {
            rule: ViolationRule.make("unresolved-graph-reference"),
            message: `Policy engine failed: ${failureMsg}`,
            path: [],
          },
        ],
        mermaid: renderMermaid(harnessGraph),
      }
    })
    .exhaustive()
}
