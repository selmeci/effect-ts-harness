import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { buildHarnessGraph } from "@harness/graph"
import {
  checkTestDomainSprawl,
  decideGraphEntropy,
  evaluateTestAndDeciderPlugin,
  MAX_TEST_SOURCE_DOMAINS,
  MIN_LINES_FOR_DOMAIN_SPRAWL,
  resolveSourceDomainBucket,
} from "../src/index.js"
import { checkUntestedContractUnionVariants } from "../src/plugins/gc/gc-test-and-decider.plugin.js"
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

const writeContractUnionWorkspace = (
  contractCode: string,
  testCode: string | undefined,
  fixtureCode?: string,
): string => {
  const dir = mkdtempSync(join(tmpdir(), "gc-union-variants-"))
  mkdirSync(join(dir, "libs/demo/contract/src"), { recursive: true })
  writeFileSync(join(dir, "libs/demo/contract/src/index.ts"), contractCode, "utf8")
  if (testCode !== undefined) {
    mkdirSync(join(dir, "libs/demo/contract/test"), { recursive: true })
    writeFileSync(join(dir, "libs/demo/contract/test/index.test.ts"), testCode, "utf8")
  }
  if (fixtureCode !== undefined) {
    mkdirSync(join(dir, "libs/demo/contract/test/fixtures"), { recursive: true })
    writeFileSync(join(dir, "libs/demo/contract/test/fixtures/f.ts"), fixtureCode, "utf8")
  }
  return dir
}

describe("GraphGc untested-union-variant gate (SPEC-0028 REQ-3.2)", () => {
  it.effect(
    "passes cleanly when all exported Schema.TaggedUnion variants are referenced in non-fixture test ASTs",
    () =>
      Effect.gen(function* () {
        const contract = [
          'import { Schema } from "effect"',
          "export const Action = Schema.TaggedUnion({",
          "  Create: { id: Schema.String },",
          '  "Delete": {},',
          "}).pipe(Schema.annotate({ title: 'Action' }))",
          "const LocalOnly = Schema.TaggedUnion({ Ignored: {} })",
        ].join("\n")
        const test = [
          'import { Action } from "../src/index.js"',
          "const a = Action.cases.Create.make({ id: '1' })",
          "const b = `Delete`",
        ].join("\n")
        const dir = writeContractUnionWorkspace(contract, test)
        try {
          const report = yield* decideGraphEntropy({
            graph: buildHarnessGraph({}),
            workspaceRoot: dir,
            hostIo: testHostIo,
          })
          expect(report.findings.filter((f) => f.kind === "untested-union-variant")).toEqual([])
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "flags unreferenced, comment-only, and fixture-only variants with exact nodeId and fails closed on unreadable files",
    () =>
      Effect.gen(function* () {
        const contract = [
          'import { Schema } from "effect"',
          "export const JobState = Schema.TaggedUnion({",
          "  Queued: {},",
          "  CommentOnly: {},",
          "  FixtureOnly: {},",
          "})",
        ].join("\n")
        const test = [
          'import { JobState } from "../src/index.js"',
          "// CommentOnly only appears inside a comment",
          'const q = "Queued"',
        ].join("\n")
        const fixture = 'export const fx = { _tag: "FixtureOnly" }'
        const dir = writeContractUnionWorkspace(contract, test, fixture)
        try {
          const report = yield* decideGraphEntropy({
            graph: buildHarnessGraph({}),
            workspaceRoot: dir,
            hostIo: testHostIo,
          })
          const missing = report.findings
            .filter((f) => f.kind === "untested-union-variant")
            .map((f) => ({ nodeId: f.nodeId, location: f.location }))
            .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
          expect(missing).toEqual([
            { nodeId: "JobState.CommentOnly", location: "libs/demo/contract/src/index.ts:4" },
            { nodeId: "JobState.FixtureOnly", location: "libs/demo/contract/src/index.ts:5" },
          ])

          const failingIo = {
            ...testHostIo,
            readTextSync: () => {
              throw new Error("EACCES")
            },
          }
          const failClosedReport = yield* decideGraphEntropy({
            graph: buildHarnessGraph({}),
            workspaceRoot: dir,
            hostIo: failingIo,
          })
          expect(
            failClosedReport.findings.some((f) => f.kind === "unreadable-workspace-file"),
          ).toBe(true)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
  )

  it.effect.prop(
    "property: untested-union-variant matches exact set difference (declared \\ tested) across generated variant subsets",
    {
      coverAlpha: Schema.Boolean,
      coverBeta: Schema.Boolean,
      coverGamma: Schema.Boolean,
    },
    ({ coverAlpha, coverBeta, coverGamma }) =>
      Effect.gen(function* () {
        const contract = [
          'import { Schema } from "effect"',
          "export const PropUnion = Schema.TaggedUnion({ Alpha: {}, Beta: {}, Gamma: {} })",
        ].join("\n")
        const tested: Array<string> = []
        if (coverAlpha) tested.push('"Alpha"')
        if (coverBeta) tested.push('"Beta"')
        if (coverGamma) tested.push('"Gamma"')
        const test = [
          'import { PropUnion } from "../src/index.js"',
          `export const covered = [${tested.join(", ")}]`,
        ].join("\n")
        const dir = writeContractUnionWorkspace(contract, test)
        try {
          const report = yield* decideGraphEntropy({
            graph: buildHarnessGraph({}),
            workspaceRoot: dir,
            hostIo: testHostIo,
          })
          const expectedMissing = [
            ...(coverAlpha ? [] : ["PropUnion.Alpha"]),
            ...(coverBeta ? [] : ["PropUnion.Beta"]),
            ...(coverGamma ? [] : ["PropUnion.Gamma"]),
          ].sort()
          const actual = report.findings
            .filter((f) => f.kind === "untested-union-variant")
            .map((f) => f.nodeId)
            .sort()
          expect(actual).toEqual(expectedMissing)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "F-15: unwraps pipe(Schema.TaggedUnion(...), ...) and ignores unrelated test files containing matching literals without importing the union",
    () =>
      Effect.gen(function* () {
        const contract = [
          'import { pipe, Schema } from "effect"',
          "export const RunStatus = pipe(",
          "  Schema.TaggedUnion({ Failed: {}, Ok: {} }),",
          '  Schema.annotate({ title: "RunStatus" }),',
          ")",
          "export const RunEnvelope = Schema.Struct({ status: RunStatus })",
        ].join("\n")
        const unrelatedTest = [
          'import { describe, expect, it } from "vitest"',
          'const msg = "Failed"',
          'it("unrelated", () => { expect(msg).toBe("Failed") })',
        ].join("\n")
        const dir = writeContractUnionWorkspace(contract, unrelatedTest)
        try {
          const report = yield* decideGraphEntropy({
            graph: buildHarnessGraph({}),
            workspaceRoot: dir,
            hostIo: testHostIo,
          })
          const missing = report.findings
            .filter((f) => f.kind === "untested-union-variant")
            .map((f) => f.nodeId)
            .sort()
          expect(missing).toEqual(["RunStatus.Failed", "RunStatus.Ok"])

          const wrapperTest = [
            'import { RunEnvelope } from "../src/index.js"',
            'export const sample = [RunEnvelope, "Failed", "Ok"]',
          ].join("\n")
          const coveredDir = writeContractUnionWorkspace(contract, wrapperTest)
          try {
            const coveredReport = yield* decideGraphEntropy({
              graph: buildHarnessGraph({}),
              workspaceRoot: coveredDir,
              hostIo: testHostIo,
            })
            expect(
              coveredReport.findings.filter((f) => f.kind === "untested-union-variant"),
            ).toEqual([])
          } finally {
            rmSync(coveredDir, { recursive: true, force: true })
          }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
  )
})

type SprawlMode =
  | "direct"
  | "named-barrel"
  | "star-barrel"
  | "dir-barrel"
  | "bare-src"
  | "ns-barrel"
  | "type-only"
  | "fixture"

const writeDomainSprawlWorkspace = (
  domainCount: number,
  lineCount: number,
  mode: SprawlMode,
  options?: { readonly includeDirectTypeImport?: boolean },
): string => {
  const dir = mkdtempSync(join(tmpdir(), "harness-domain-sprawl-"))
  const pkgSrcDir = join(dir, "libs", "demo", "domain", "src")
  const testSubdir =
    mode === "fixture"
      ? join(dir, "libs", "demo", "domain", "test", "fixtures")
      : join(dir, "libs", "demo", "domain", "test")
  mkdirSync(pkgSrcDir, { recursive: true })
  mkdirSync(testSubdir, { recursive: true })

  const indexLines: Array<string> = []
  for (let i = 1; i <= domainCount; i += 1) {
    writeFileSync(join(pkgSrcDir, `dom_${i}.ts`), `export const domFn${i} = (): number => ${i}\n`)
    if (mode === "star-barrel" && i === domainCount) {
      writeFileSync(
        join(pkgSrcDir, `dom_${i}_star.ts`),
        `export function domStarFn${i}(): number {\n  return ${i}\n}\n`,
      )
      indexLines.push(`export * from "./dom_${i}_star.js"`)
    } else if (mode === "dir-barrel" && i === domainCount) {
      const subDir = join(pkgSrcDir, `dom_${i}_dir`)
      mkdirSync(subDir, { recursive: true })
      writeFileSync(join(subDir, "index.ts"), `export const domDirFn${i} = (): number => ${i}\n`)
      indexLines.push(`export { domDirFn${i} } from "./dom_${i}_dir"`)
    } else {
      indexLines.push(`export { domFn${i} } from "./dom_${i}.js"`)
    }
  }
  if (options?.includeDirectTypeImport === true) {
    writeFileSync(join(pkgSrcDir, "dom_type_only.ts"), "export type DomTypeOnly = number\n")
  }
  writeFileSync(join(pkgSrcDir, "index.ts"), `${indexLines.join("\n")}\n`)

  const lines: Array<string> = []
  if (options?.includeDirectTypeImport === true) {
    lines.push('import { type DomTypeOnly } from "../src/dom_type_only.js"')
  }
  const padStartIdx = (() => {
    if (mode === "direct" || mode === "fixture") {
      const relPrefix = mode === "fixture" ? "../../src" : "../src"
      for (let i = 1; i <= domainCount; i += 1) {
        lines.push(`import { domFn${i} } from "${relPrefix}/dom_${i}.js"`)
      }
      lines.push(
        `export const refs = [${Array.from({ length: domainCount }, (_, idx) => `domFn${idx + 1}`).join(", ")}]`,
      )
      return lines.length
    }
    if (mode === "named-barrel" || mode === "bare-src") {
      const syms = Array.from({ length: domainCount }, (_, idx) => `domFn${idx + 1}`).join(", ")
      const importSpec = mode === "bare-src" ? "../src" : "../src/index.js"
      lines.push(`import { ${syms} } from "${importSpec}"`)
      lines.push(`export const refs = [${syms}]`)
      return lines.length
    }
    if (mode === "dir-barrel") {
      const syms = Array.from({ length: domainCount }, (_, idx) =>
        idx + 1 === domainCount ? `domDirFn${domainCount}` : `domFn${idx + 1}`,
      )
      lines.push(`import { ${syms.join(", ")} } from "../src/index.js"`)
      lines.push(`export const refs = [${syms.join(", ")}]`)
      return lines.length
    }
    if (mode === "star-barrel") {
      const syms = Array.from({ length: domainCount }, (_, idx) =>
        idx + 1 === domainCount ? `domStarFn${domainCount}` : `domFn${idx + 1}`,
      )
      lines.push(`import { ${syms.join(", ")} } from "../src/index.js"`)
      lines.push(`export const refs = [${syms.join(", ")}]`)
      return lines.length
    }
    if (mode === "ns-barrel") {
      lines.push('import * as DemoPkg from "../src/index.js"')
      const calls = Array.from({ length: domainCount }, (_, idx) => `DemoPkg.domFn${idx + 1}`).join(
        ", ",
      )
      lines.push(`export const refs = [${calls}]`)
      return lines.length
    }
    const syms = Array.from({ length: domainCount }, (_, idx) => `type domFn${idx + 1}`).join(", ")
    lines.push(`import { ${syms} } from "../src/index.js"`)
    lines.push("export type Sample = typeof domFn1")
    return lines.length
  })()

  for (let i = padStartIdx; i < lineCount; i += 1) {
    lines.push(`const pad_${i} = ${i}`)
  }
  writeFileSync(join(testSubdir, "suite.test.ts"), lines.join("\n"))
  return dir
}

describe("GraphGc test-domain-sprawl gate (SPEC-0028 REQ-3.4)", () => {
  it("resolveSourceDomainBucket maps nested plugins, commands, subdirectories, and flat modules deterministically", () => {
    expect(MAX_TEST_SOURCE_DOMAINS).toBe(6)
    expect(MIN_LINES_FOR_DOMAIN_SPRAWL).toBe(300)
    expect(resolveSourceDomainBucket("./plugins/gc/gc-helpers.js")).toBe("plugins/gc")
    expect(resolveSourceDomainBucket("plugins/ast-cache.ts")).toBe("plugins")
    expect(resolveSourceDomainBucket("commands/verify-and-done.command.js")).toBe(
      "commands/verify-and-done.command",
    )
    expect(resolveSourceDomainBucket("mutation/mutation-cache.ts")).toBe("mutation")
    expect(resolveSourceDomainBucket("policy.ts")).toBe("policy")
  })

  it.effect(
    "allows <= 6 domains and compact < 300 line cross-cutting suites, while flagging 7 domains at 300+ lines",
    () =>
      Effect.gen(function* () {
        const sixDomainsDir = writeDomainSprawlWorkspace(6, 350, "direct", {
          includeDirectTypeImport: true,
        })
        const compactSevenDir = writeDomainSprawlWorkspace(7, 299, "direct")
        const exactThresholdDir = writeDomainSprawlWorkspace(7, 300, "direct")
        try {
          const sixFindings = checkTestDomainSprawl(sixDomainsDir, testHostIo)
          expect(sixFindings).toEqual([])

          const compactFindings = checkTestDomainSprawl(compactSevenDir, testHostIo)
          expect(compactFindings).toEqual([])

          const report = yield* decideGraphEntropy({
            graph: buildHarnessGraph({}),
            workspaceRoot: exactThresholdDir,
            hostIo: testHostIo,
          })
          const hits = report.findings.filter((f) => f.kind === "test-domain-sprawl")
          expect(hits).toHaveLength(1)
          expect(hits[0]?.nodeId).toBe("libs/demo/domain/test/suite.test.ts")
          expect(hits[0]?.message).toContain("spans 7 distinct production source domains")
        } finally {
          rmSync(sixDomainsDir, { recursive: true, force: true })
          rmSync(compactSevenDir, { recursive: true, force: true })
          rmSync(exactThresholdDir, { recursive: true, force: true })
        }
      }),
  )

  it("resolves named, star re-export, directory index, bare src, and namespace imports through barrel index.ts while ignoring type-only and fixture imports", () => {
    const namedDir = writeDomainSprawlWorkspace(7, 320, "named-barrel")
    const starDir = writeDomainSprawlWorkspace(7, 320, "star-barrel")
    const dirBarrelDir = writeDomainSprawlWorkspace(7, 320, "dir-barrel")
    const bareSrcDir = writeDomainSprawlWorkspace(7, 320, "bare-src")
    const nsDir = writeDomainSprawlWorkspace(7, 320, "ns-barrel")
    const typeOnlyDir = writeDomainSprawlWorkspace(8, 350, "type-only")
    const fixtureDir = writeDomainSprawlWorkspace(8, 350, "fixture")
    try {
      expect(checkTestDomainSprawl(namedDir, testHostIo)).toHaveLength(1)
      expect(checkTestDomainSprawl(starDir, testHostIo)).toHaveLength(1)
      expect(checkTestDomainSprawl(dirBarrelDir, testHostIo)).toHaveLength(1)
      expect(checkTestDomainSprawl(bareSrcDir, testHostIo)).toHaveLength(1)
      expect(checkTestDomainSprawl(nsDir, testHostIo)).toHaveLength(1)
      expect(checkTestDomainSprawl(typeOnlyDir, testHostIo)).toEqual([])
      expect(checkTestDomainSprawl(fixtureDir, testHostIo)).toEqual([])
    } finally {
      rmSync(namedDir, { recursive: true, force: true })
      rmSync(starDir, { recursive: true, force: true })
      rmSync(dirBarrelDir, { recursive: true, force: true })
      rmSync(bareSrcDir, { recursive: true, force: true })
      rmSync(nsDir, { recursive: true, force: true })
      rmSync(typeOnlyDir, { recursive: true, force: true })
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it("checkUntestedContractUnionVariants scans workspace test files directly when preParsedTestFiles is omitted", () => {
    const unionDir = mkdtempSync(join(tmpdir(), "harness-untested-union-direct-"))
    try {
      const contractSrcDir = join(unionDir, "libs", "demo", "contract", "src")
      const contractTestDir = join(unionDir, "libs", "demo", "contract", "test")
      mkdirSync(contractSrcDir, { recursive: true })
      mkdirSync(contractTestDir, { recursive: true })
      writeFileSync(
        join(contractSrcDir, "union.ts"),
        [
          'import { Schema } from "effect"',
          "export const MyEvt = Schema.TaggedUnion({",
          "  Alpha: Schema.Struct({ a: Schema.String }),",
          "  Beta: Schema.Struct({ b: Schema.String }),",
          "})",
        ].join("\n"),
      )
      writeFileSync(
        join(contractTestDir, "union.test.ts"),
        [
          'import { MyEvt } from "../src/union.js"',
          'export const tag = "Alpha"',
          "void MyEvt",
        ].join("\n"),
      )
      const findings = checkUntestedContractUnionVariants(unionDir, testHostIo)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.kind).toBe("untested-union-variant")
      expect(findings[0]?.nodeId).toBe("MyEvt.Beta")
    } finally {
      rmSync(unionDir, { recursive: true, force: true })
    }
  })

  it.effect.prop(
    "property: emits test-domain-sprawl iff lineCount >= 300 and domainCount > 6",
    {
      domainCount: Schema.Literals([5, 6, 7, 8]),
      lineCount: Schema.Literals([250, 299, 300, 350]),
    },
    ({ domainCount, lineCount }) =>
      Effect.sync(() => {
        const dir = writeDomainSprawlWorkspace(domainCount, lineCount, "named-barrel")
        try {
          const findings = checkTestDomainSprawl(dir, testHostIo)
          const expectedCount =
            lineCount >= MIN_LINES_FOR_DOMAIN_SPRAWL && domainCount > MAX_TEST_SOURCE_DOMAINS
              ? 1
              : 0
          expect(findings.filter((f) => f.kind === "test-domain-sprawl")).toHaveLength(
            expectedCount,
          )
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
  )
})
