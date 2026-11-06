import { Effect } from "effect"
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

export const isCloudBinding = (node: ServiceTagNode): boolean =>
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/.test(node.tagId) ||
  /^(Cloudflare|Alchemy|Drizzle|Provider|Binding)\b/.test(node.name)

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

const POLICY_CHECK_RULES: ReadonlySet<ViolationRule> = new Set<ViolationRule>([
  "domain-requires-infra",
  "domain-requires-cloud-binding",
  "impure-decider",
  "impure-reducer",
  "aggregate-direct-bus-publish",
  "layer-cycle",
  "unmapped-spec-symbol",
])

/**
 * Evaluates architectural graph policies over the PERA Levi Hypergraph by delegating
 * to the Stratified Datalog inference engine (`GraphInfer.decide` in `datalog-engine.ts`)
 * and combining AST branching violations (`discriminant-branching`, `non-exhaustive-union-match`).
 */
export const checkEffectGraph = (harnessGraph: HarnessGraph): CheckEffectGraphResult => {
  const violations: Array<GraphPolicyViolation> = []

  const inference = Effect.runSync(decideGraphInference(harnessGraph))

  for (const ap of inference.antiPatterns) {
    if (POLICY_CHECK_RULES.has(ap.ruleId)) {
      violations.push({
        rule: ap.ruleId,
        message: ap.message,
        path: ap.path,
      })
    }
  }

  for (const bv of harnessGraph.branchingViolations ?? []) {
    violations.push({
      rule: bv.rule,
      message: bv.message,
      path: bv.path ?? [bv.file, bv.enclosingSymbol],
    })
  }

  const mermaid = renderMermaid(harnessGraph)

  return {
    ok: violations.length === 0,
    violations,
    mermaid,
  }
}
