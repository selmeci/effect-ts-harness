/**
 * Test & Pure Decider Entropy Gate Plugin.
 *
 * Verifies test reachability and property-based test coverage for domain functions.
 *
 * Rules owned:
 * - untested-effect-fn: Flags domain/contract EffectFn symbols with 0 reaching tests.
 * - missing-decider-property-test: Flags domain deciders lacking property-based test coverage.
 * - shallow-decider-property-test: Flags deciders exercised only by scalar/primitive arbitraries.
 */
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
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

  // Rule: untested-effect-fn
  if (input.checkUntestedDomainFns === true || ctx.hasVitestCases) {
    for (const [idx, node] of Graph.nodes(g)) {
      match(node)
        .with({ _tag: "EffectFn" }, (n) => {
          if (
            (n.packageTag === "domain" || n.packageTag === "contract") &&
            !n.isStub &&
            !IGNORED_UNTESTED_FNS.has(n.spanName) &&
            (ctx.incomingTestOrCall.get(idx) ?? 0) === 0
          ) {
            findings.push({
              kind: "untested-effect-fn",
              nodeId: n.spanName,
              location: `${n.file}:${n.line}`,
              message: `Domain EffectFn "${n.spanName}" (${n.qualname}) has 0 reaching tests (0 ExercisesSpan / TracedCall edges).`,
              action: `Add a unit/integration test importing and calling "${n.spanName}" to verify domain behavior.`,
            })
          }
        })
        .with(
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "PatternDoc" },
          { _tag: "SchemaDef" },
          { _tag: "ServiceLayer" },
          { _tag: "ServiceTag" },
          { _tag: "TaggedError" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          { _tag: "VitestCase" },
          () => {},
        )
        .exhaustive()
    }
  }

  // Rules: missing-decider-property-test & shallow-decider-property-test
  if (input.checkDeciderPropertyTests === true) {
    for (const [idx, node] of Graph.nodes(g)) {
      match(node)
        .with({ _tag: "EffectFn" }, (n) => {
          if (
            (n.packageTag === "domain" || n.packageTag === "contract") &&
            !n.isStub &&
            (n.spanName.endsWith(".decide") || n.spanName === "decide") &&
            !IGNORED_UNTESTED_FNS.has(n.spanName)
          ) {
            if ((ctx.incomingPropertyTests.get(idx) ?? 0) === 0) {
              findings.push({
                kind: "missing-decider-property-test",
                nodeId: n.spanName,
                location: `${n.file}:${n.line}`,
                message: `Pure domain decider "${n.spanName}" (${n.qualname}) has 0 Property-Based Tests (use it.effect.prop / it.prop with Schema arbitraries to prevent example-only blind spots).`,
                action: `Create a property-based test with it.effect.prop / it.prop using fast-check / Schema arbitraries exercising "${n.spanName}".`,
              })
              return
            }
            if ((ctx.incomingRichPropertyTests.get(idx) ?? 0) === 0) {
              findings.push({
                kind: "shallow-decider-property-test",
                nodeId: n.spanName,
                location: `${n.file}:${n.line}`,
                message: `Pure domain decider "${n.spanName}" (${n.qualname}) is only exercised by scalar/primitive property tests — generate domain Event or Command schemas (e.g. Schema.Array(EventSchema)) in it.prop / it.effect.prop.`,
                action: `Replace scalar arguments in it.prop / it.effect.prop with composite domain generators (e.g. Schema.Array(EventSchema)).`,
              })
            }
          }
        })
        .with(
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "PatternDoc" },
          { _tag: "SchemaDef" },
          { _tag: "ServiceLayer" },
          { _tag: "ServiceTag" },
          { _tag: "TaggedError" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          { _tag: "VitestCase" },
          () => {},
        )
        .exhaustive()
    }
  }

  return findings
}
