import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { decideGraphInference } from "./datalog-engine.js"
import { renderMermaid } from "./graph-engine.js"
import {
  type EffectFnNode,
  type HarnessGraph,
  type ServiceTagNode,
  type ViolationRule,
} from "./model.js"

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
   * - `missing-layer-provider` (enforced during Layer composition / `gc-check.ts`)
   * - `untested-domain-span` (enforced during implementation / `gc-check.ts`)
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

export const isCloudBinding = (node: ServiceTagNode): boolean =>
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)(\b|[A-Z])/.test(node.tagId) ||
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)(\b|[A-Z])/.test(node.name)

export const isDeciderSpan = (spanName: string): boolean =>
  spanName.endsWith(".decide") || spanName === "decide"

export const isReducerSpan = (spanName: string): boolean =>
  spanName.endsWith(".evolve") ||
  spanName === "evolve" ||
  spanName.endsWith(".fold") ||
  spanName === "fold"

export const isAggregateFnNode = (node: EffectFnNode): boolean =>
  node.spanName.startsWith("Aggregate.") ||
  node.spanName.startsWith("AggregateInfra.") ||
  node.spanName.startsWith("AggregateHttp.") ||
  node.spanName.endsWith(".handleCommand") ||
  node.spanName.endsWith(".executeCommand") ||
  /(?:-aggregate|\.aggregate|\/aggregate|^aggregate)\.ts$/.test(node.file)

export const isEventBusServiceNode = (node: ServiceTagNode): boolean =>
  node.tagId === "EventBus" ||
  node.tagId.endsWith("EventBus") ||
  node.tagId.endsWith(".EventBus") ||
  node.name === "EventBus" ||
  node.name.endsWith("EventBus")

export const isOutboxDrainOrBusPublishFnNode = (node: EffectFnNode): boolean =>
  node.spanName === "Outbox.drain" ||
  node.spanName === "EventBus.publish" ||
  node.qualname.includes("Outbox.drain") ||
  node.qualname.includes("EventBus.publish")

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

/**
 * Pure Effect decider (`GraphPolicy.decide`) evaluating architectural graph policies
 * by delegating to the Stratified Datalog inference engine (`GraphInfer.decide`).
 */
export const decideEffectGraphPolicy = Effect.fn("GraphPolicy.decide")(function* (
  harnessGraph: HarnessGraph,
  options?: CheckEffectGraphOptions,
) {
  const violations: Array<GraphPolicyViolation> = []

  const inference = yield* decideGraphInference(harnessGraph)

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
})

/**
 * Evaluates architectural graph policies over the PERA Levi Hypergraph by delegating
 * to `decideEffectGraphPolicy` (`GraphPolicy.decide`).
 *
 * Catches any engine failures safely via `Effect.runSyncExit`, converting failure causes
 * into structured `GraphPolicyViolation` records rather than throwing unhandled `FiberFailure`.
 */
export const checkEffectGraph = (
  harnessGraph: HarnessGraph,
  options?: CheckEffectGraphOptions,
): CheckEffectGraphResult => {
  const exit = Effect.runSyncExit(decideEffectGraphPolicy(harnessGraph, options))
  return match(exit)
    .with({ _tag: "Success" }, ({ value }) => value)
    .with({ _tag: "Failure" }, ({ cause }) => {
      const failureMsg = Cause.pretty(cause)
      return {
        ok: false,
        violations: [
          {
            rule: "unresolved-graph-reference" as ViolationRule,
            message: `Policy engine failed: ${failureMsg}`,
            path: [],
          },
        ],
        mermaid: renderMermaid(harnessGraph),
      }
    })
    .exhaustive()
}
