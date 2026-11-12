import * as Graph from "effect/Graph"
import {
  type GcFinding,
  type GraphEntropyInput,
  type GraphReachabilityContext,
  IGNORED_UNTESTED_FNS,
} from "./gc-helpers.js"

export const evaluateTestAndDeciderPlugin = (
  input: GraphEntropyInput,
  ctx: GraphReachabilityContext,
): ReadonlyArray<GcFinding> => {
  const g = input.graph.graph
  const findings: Array<GcFinding> = []

  // 3. untested-effect-fn
  if (input.checkUntestedDomainFns === true || ctx.hasVitestCases) {
    for (const [idx, node] of Graph.nodes(g)) {
      if (
        node._tag === "EffectFn" &&
        (node.packageTag === "domain" || node.packageTag === "contract") &&
        !node.isStub &&
        !IGNORED_UNTESTED_FNS.has(node.spanName)
      ) {
        if ((ctx.incomingTestOrCall.get(idx) ?? 0) === 0) {
          findings.push({
            kind: "untested-effect-fn",
            nodeId: node.spanName,
            location: `${node.file}:${node.line}`,
            message: `Domain EffectFn "${node.spanName}" (${node.qualname}) has 0 reaching tests (0 ExercisesSpan / TracedCall edges).`,
            action: `Add a unit/integration test importing and calling "${node.spanName}" to verify domain behavior.`,
          })
        }
      }
    }
  }

  // 3b. missing-decider-property-test and shallow-decider-property-test
  if (input.checkDeciderPropertyTests === true) {
    for (const [idx, node] of Graph.nodes(g)) {
      if (
        node._tag === "EffectFn" &&
        (node.packageTag === "domain" || node.packageTag === "contract") &&
        !node.isStub &&
        (node.spanName.endsWith(".decide") || node.spanName === "decide") &&
        !IGNORED_UNTESTED_FNS.has(node.spanName)
      ) {
        if ((ctx.incomingPropertyTests.get(idx) ?? 0) === 0) {
          findings.push({
            kind: "missing-decider-property-test",
            nodeId: node.spanName,
            location: `${node.file}:${node.line}`,
            message: `Pure domain decider "${node.spanName}" (${node.qualname}) has 0 Property-Based Tests (use it.effect.prop / it.prop with Schema arbitraries to prevent example-only blind spots).`,
            action: `Create a property-based test with it.effect.prop / it.prop using fast-check / Schema arbitraries exercising "${node.spanName}".`,
          })
        } else if ((ctx.incomingRichPropertyTests.get(idx) ?? 0) === 0) {
          findings.push({
            kind: "shallow-decider-property-test",
            nodeId: node.spanName,
            location: `${node.file}:${node.line}`,
            message: `Pure domain decider "${node.spanName}" (${node.qualname}) is only exercised by scalar/primitive property tests — generate domain Event or Command schemas (e.g. Schema.Array(EventSchema)) in it.prop / it.effect.prop.`,
            action: `Replace scalar arguments in it.prop / it.effect.prop with composite domain generators (e.g. Schema.Array(EventSchema)).`,
          })
        }
      }
    }
  }

  return findings
}
