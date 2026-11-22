import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { buildHarnessGraph } from "@harness/graph"
import { decideGraphEntropy, evaluateTestAndDeciderPlugin } from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

const ExecutableTagSchema = Schema.Literals(["domain", "contract", "infra", "app"])
const PropertyKindSchema = Schema.Literals([
  "none",
  "non-property",
  "scalar-property",
  "rich-property",
])

describe("GraphGc test & decider reachability plugin (SPEC-0026)", () => {
  it.effect(
    "flags untested-effect-fn across domain, contract, infra, and app while ignoring stubs and tested functions",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/demo/domain/src/index.ts#domUntested",
              spanName: "Demo.domUntested",
              packageTag: "domain",
              file: "libs/demo/domain/src/index.ts",
              line: 5,
            },
            {
              qualname: "libs/demo/contract/src/index.ts#conUntested",
              spanName: "Demo.conUntested",
              packageTag: "contract",
              file: "libs/demo/contract/src/index.ts",
              line: 5,
            },
            {
              qualname: "libs/demo/infra/src/index.ts#infUntested",
              spanName: "Demo.infUntested",
              packageTag: "infra",
              file: "libs/demo/infra/src/index.ts",
              line: 5,
            },
            {
              qualname: "apps/demo-cli/src/index.ts#appUntested",
              spanName: "Demo.appUntested",
              packageTag: "app",
              file: "apps/demo-cli/src/index.ts",
              line: 5,
            },
            {
              qualname: "libs/demo/service/src/index.ts#svcUntested",
              spanName: "Demo.svcUntested",
              packageTag: "service",
              file: "libs/demo/service/src/index.ts",
              line: 5,
            },
            {
              qualname: "libs/demo/infra/src/stub.ts#infStub",
              spanName: "Demo.infStub",
              packageTag: "infra",
              file: "libs/demo/infra/src/stub.ts",
              line: 5,
              isStub: true,
            },
            {
              qualname: "apps/demo-cli/src/tested.ts#appTested",
              spanName: "Demo.appTested",
              packageTag: "app",
              file: "apps/demo-cli/src/tested.ts",
              line: 5,
            },
          ],
          tests: [
            {
              testId: "test-app-1",
              testFile: "apps/demo-cli/test/app.test.ts",
              testName: "exercises appTested",
            },
          ],
          exercisesSpans: [
            {
              testId: "test-app-1",
              calleeQualname: "apps/demo-cli/src/tested.ts#appTested",
              callCount: 1,
              receiverLayer: null,
            },
          ],
        })

        const report = yield* decideGraphEntropy({
          graph,
          hostIo: testHostIo,
          checkUntestedDomainFns: true,
          checkDeciderPropertyTests: false,
        })
        const untestedIds = report.findings
          .filter((f) => f.kind === "untested-effect-fn")
          .map((f) => f.nodeId)
          .sort()

        expect(untestedIds).toEqual([
          "Demo.appUntested",
          "Demo.conUntested",
          "Demo.domUntested",
          "Demo.infUntested",
        ])
      }),
  )

  it.effect(
    "flags missing-decider-property-test and shallow-decider-property-test without legacy IGNORED_UNTESTED_FNS exemptions",
    () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/harness/gates/src/friction-log.ts#decideFrictionClusters",
              spanName: "Friction.decide",
              packageTag: "domain",
              file: "libs/harness/gates/src/friction-log.ts",
              line: 85,
            },
            {
              qualname: "libs/harness/gates/src/shallow.ts#decideShallow",
              spanName: "Shallow.decide",
              packageTag: "domain",
              file: "libs/harness/gates/src/shallow.ts",
              line: 10,
            },
            {
              qualname: "libs/harness/gates/src/rich.ts#decideRich",
              spanName: "Rich.decide",
              packageTag: "domain",
              file: "libs/harness/gates/src/rich.ts",
              line: 10,
            },
          ],
          tests: [
            {
              testId: "test-friction-unit",
              testFile: "libs/harness/gates/test/friction-log.test.ts",
              testName: "unit test",
              isPropertyTest: false,
            },
            {
              testId: "test-shallow-prop",
              testFile: "libs/harness/gates/test/shallow.test.ts",
              testName: "scalar prop",
              isPropertyTest: true,
              hasNonPrimitiveArbitrary: false,
            },
            {
              testId: "test-rich-prop",
              testFile: "libs/harness/gates/test/rich.test.ts",
              testName: "composite prop",
              isPropertyTest: true,
              hasNonPrimitiveArbitrary: true,
            },
          ],
          exercisesSpans: [
            {
              testId: "test-friction-unit",
              calleeQualname: "libs/harness/gates/src/friction-log.ts#decideFrictionClusters",
              callCount: 1,
              receiverLayer: null,
            },
            {
              testId: "test-shallow-prop",
              calleeQualname: "libs/harness/gates/src/shallow.ts#decideShallow",
              callCount: 1,
              receiverLayer: null,
            },
            {
              testId: "test-rich-prop",
              calleeQualname: "libs/harness/gates/src/rich.ts#decideRich",
              callCount: 1,
              receiverLayer: null,
            },
          ],
        })

        const report = yield* decideGraphEntropy({
          graph,
          hostIo: testHostIo,
          checkUntestedDomainFns: true,
          checkDeciderPropertyTests: true,
        })

        expect(
          report.findings
            .filter((f) => f.kind === "missing-decider-property-test")
            .map((f) => f.nodeId),
        ).toEqual(["Friction.decide"])
        expect(
          report.findings
            .filter((f) => f.kind === "shallow-decider-property-test")
            .map((f) => f.nodeId),
        ).toEqual(["Shallow.decide"])
      }),
  )

  it.effect.prop(
    "decideGraphEntropy property: executable EffectFn reachability and decider property checks satisfy exact tier and arbitrary invariants",
    {
      specs: Schema.Array(
        Schema.Struct({
          packageTag: ExecutableTagSchema,
          isStub: Schema.Boolean,
          isDecider: Schema.Boolean,
          propertyKind: PropertyKindSchema,
        }),
      ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8))),
    },
    ({ specs }) =>
      Effect.gen(function* () {
        const fns = specs.map((spec, idx) => ({
          qualname: `libs/demo/${spec.packageTag}/src/m-${idx}.ts#fn${idx}`,
          spanName: spec.isDecider ? `Spec${idx}.decide` : `Spec${idx}.run`,
          packageTag: spec.packageTag,
          file: `libs/demo/${spec.packageTag}/src/m-${idx}.ts`,
          line: 10 + idx,
          ...(spec.isStub ? { isStub: true } : {}),
        }))
        const tests = specs.flatMap((spec, idx) =>
          spec.propertyKind === "none"
            ? []
            : [
                {
                  testId: `t-${idx}`,
                  testFile: `libs/demo/${spec.packageTag}/test/m-${idx}.test.ts`,
                  testName: `covers fn${idx}`,
                  isPropertyTest: spec.propertyKind !== "non-property",
                  hasNonPrimitiveArbitrary: spec.propertyKind === "rich-property",
                },
              ],
        )
        const exercisesSpans = specs.flatMap((spec, idx) =>
          spec.propertyKind === "none"
            ? []
            : [
                {
                  testId: `t-${idx}`,
                  calleeQualname: `libs/demo/${spec.packageTag}/src/m-${idx}.ts#fn${idx}`,
                  callCount: 1,
                  receiverLayer: null,
                },
              ],
        )
        const graph = buildHarnessGraph({ fns, tests, exercisesSpans })
        const report = yield* decideGraphEntropy({
          graph,
          hostIo: testHostIo,
          checkUntestedDomainFns: true,
          checkDeciderPropertyTests: true,
        })

        const untestedSet = new Set(
          report.findings.filter((f) => f.kind === "untested-effect-fn").map((f) => f.nodeId),
        )
        const missingPropSet = new Set(
          report.findings
            .filter((f) => f.kind === "missing-decider-property-test")
            .map((f) => f.nodeId),
        )
        const shallowPropSet = new Set(
          report.findings
            .filter((f) => f.kind === "shallow-decider-property-test")
            .map((f) => f.nodeId),
        )

        specs.forEach((spec, idx) => {
          const spanName = fns[idx]!.spanName
          const expectUntested = !spec.isStub && spec.propertyKind === "none"
          expect(untestedSet.has(spanName)).toBe(expectUntested)

          const isDomainOrContract = spec.packageTag === "domain" || spec.packageTag === "contract"
          const expectMissingProp =
            !spec.isStub &&
            spec.isDecider &&
            isDomainOrContract &&
            (spec.propertyKind === "none" || spec.propertyKind === "non-property")
          expect(missingPropSet.has(spanName)).toBe(expectMissingProp)

          const expectShallowProp =
            !spec.isStub &&
            spec.isDecider &&
            isDomainOrContract &&
            spec.propertyKind === "scalar-property"
          expect(shallowPropSet.has(spanName)).toBe(expectShallowProp)
        })
      }),
  )

  it("evaluateTestAndDeciderPlugin directly checks empty graph clean findings", () => {
    const emptyGraph = buildHarnessGraph({
      fns: [],
      services: [],
      layers: [],
      errors: [],
      tests: [],
    })
    const directFindings = evaluateTestAndDeciderPlugin(
      { graph: emptyGraph, checkUntestedDomainFns: true, checkDeciderPropertyTests: true },
      {
        nodeByIndex: new Map(),
        nodeIndexById: new Map(),
        incomingByTarget: new Map(),
        outgoingBySource: new Map(),
        providedServiceIds: new Set(),
        requiredServiceIds: new Set(),
        producedErrorIds: new Set(),
        handledErrorIds: new Set(),
        reachableNodeIds: new Set(),
        appEntryIndices: [],
        exportedTestIndices: [],
        incomingRequires: new Map(),
        incomingLayerRequires: new Map(),
        incomingProvides: new Map(),
        incomingFailsWith: new Map(),
        incomingTestOrCall: new Map(),
        incomingPropertyTests: new Map(),
        incomingRichPropertyTests: new Map(),
        hasVitestCases: false,
      },
    )
    expect(directFindings).toEqual([])
  })
})
