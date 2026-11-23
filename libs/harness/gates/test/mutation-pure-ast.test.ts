import { resolve } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { match } from "ts-pattern"
import {
  analyzeModulePurityAst,
  classifyMutationModulePurity,
  isPureMutationCandidate,
} from "../src/mutation/mutation-pure-ast.js"
import { findDomainFiles } from "../src/mutation/mutation-target-discovery.js"
import { testHostIo } from "./helpers/test-host-io.js"

const REAL_REPO_ROOT = resolve(import.meta.dirname, "../../../..")

describe("mutation-pure-ast (F-17.4, F-4.1, F-10.1)", () => {
  it("extracts relative value imports (static, re-export, dynamic import(), require()) while ignoring type-only imports", () => {
    const analysis = analyzeModulePurityAst(
      "libs/demo/inf/src/mod.ts",
      [
        'import type { TypeOnly } from "./type-only.js"',
        'import { type InlineType } from "./inline-type.js"',
        'import { a } from "./val-a.js"',
        'export { b } from "./val-b.js"',
        'export type { T } from "./type-reexp.js"',
        'export const loadC = () => import("./dyn-c.js")',
        'export const loadD = () => require("./req-d.js")',
        "export type X = TypeOnly | InlineType | T",
      ].join("\n"),
    )
    expect(analysis.classification).toEqual({ _tag: "Pure" })
    expect(analysis.relativeValueImports).toEqual([
      "./val-a.js",
      "./val-b.js",
      "./dyn-c.js",
      "./req-d.js",
    ])
  })

  it("excludes entrypoints, configs, declarations, type-only files, internal I/O stems, and live host symbols", () => {
    const excludedCases: ReadonlyArray<readonly [string, string, string]> = [
      ["libs/demo/inf/src/types.d.ts", "export declare const x: number\n", "non-module"],
      ["libs/demo/inf/vitest.config.ts", "export default {}\n", "non-module"],
      ["libs/demo/inf/src/index.ts", "export const x = 1\n", "entrypoint or barrel"],
      ["libs/demo/inf/src/index.tsx", "export const x = 1\n", "entrypoint or barrel"],
      ["apps/demo/src/hook-entry.ts", "export const x = 1\n", "entrypoint or barrel"],
      ["apps/demo/src/server.ts", "export const x = 1\n", "entrypoint or barrel"],
      [
        "libs/demo/inf/src/reexp-only.ts",
        'export * from "./a.js"\nexport type A = string\n',
        "type-only or re-export-only",
      ],
      [
        "libs/demo/inf/src/internal-io.ts",
        'import { makeNodeHostIo } from "./node-host-io.js"\nexport const io = makeNodeHostIo()\n',
        "internal I/O module",
      ],
      [
        "libs/demo/inf/src/internal-dyn.ts",
        'export const d = () => import("./omnigraph-workflow-store.js")\n',
        "internal I/O module",
      ],
      [
        "libs/demo/inf/src/internal-req.ts",
        'export const r = () => require("./unix-socket-daemon")\n',
        "internal I/O module",
      ],
      [
        "libs/demo/inf/src/omni.ts",
        "export const c = () => new OmnigraphClient()\n",
        "OmnigraphClient",
      ],
      [
        "libs/demo/inf/src/gfetch.ts",
        'export const f = () => globalThis.fetch("http://127.0.0.1")\n',
        "globalThis.fetch",
      ],
      [
        "libs/demo/inf/src/gproc-bracket.ts",
        'export const e = () => globalThis["process"].env["HOME"]\n',
        "process.env",
      ],
      [
        "libs/demo/inf/src/proc-dyn.ts",
        "export const e = (k: string) => process[k]\n",
        "process[...]",
      ],
      [
        "libs/demo/inf/src/proc-rest.ts",
        "export const e = () => { const { ...rest } = process; return rest }\n",
        "destructures runtime global 'process'",
      ],
      [
        "libs/demo/inf/src/ext-io.ts",
        "export const useIo = (x = nodeExtendedHostIo) => x\n",
        "nodeExtendedHostIo",
      ],
      [
        "libs/demo/inf/src/wf-client.ts",
        "export const mk = () => makeWorkflowOmnigraphClient()\n",
        "makeWorkflowOmnigraphClient",
      ],
      [
        "libs/demo/inf/src/cluster-ns.ts",
        'import * as Cluster from "effect/cluster"\nexport const x = Cluster\n',
        "effect/cluster",
      ],
      [
        "libs/demo/inf/src/cluster-star-exp.ts",
        'export * from "effect/cluster"\nexport const x = 1\n',
        "effect/cluster",
      ],
      [
        "libs/demo/inf/src/effect-star-exp.ts",
        'export * from "effect"\nexport const x = 1\n',
        "effect",
      ],
      [
        "libs/demo/inf/src/cluster-bad-exp.ts",
        'export { Sharding } from "effect/cluster"\nexport const x = 1\n',
        "Sharding",
      ],
      [
        "libs/demo/inf/src/layer-effect.ts",
        'export const l = Layer.scoped("tag", Effect.void)\n',
        "Layer.scoped",
      ],
    ]

    for (const [relPath, src, expectedSnippet] of excludedCases) {
      const res = classifyMutationModulePurity(relPath, src)
      match(res)
        .with({ _tag: "Excluded" }, ({ reason }) => {
          expect(reason, relPath).toContain(expectedSnippet)
        })
        .with({ _tag: "Pure" }, () => {
          expect.unreachable(`Expected Excluded for ${relPath}`)
        })
        .exhaustive()
      expect(isPureMutationCandidate(relPath, src), relPath).toBe(false)
    }

    expect(
      classifyMutationModulePurity(
        "libs/demo/inf/src/cluster-exp-ok.ts",
        'export { ClusterError } from "effect/cluster"\nexport const ok = (x: number) => x + 1\n',
      ),
    ).toEqual({ _tag: "Pure" })

    expect(
      classifyMutationModulePurity(
        "libs/demo/inf/src/proc-pid.ts",
        "export const getPid = (): number => { const { pid } = process; return pid }\n",
      ),
    ).toEqual({ _tag: "Pure" })
  })

  it("F-4.1: visits runtime expressions inside class extends heritage clauses while skipping implements and typeArguments", () => {
    const badExtends = [
      "declare function makeBase(io: unknown): new () => object",
      "export class BadService extends makeBase(nodeSyncHostIo) {",
      "  readonly x = 1",
      "}",
    ].join("\n")
    const resExtends = classifyMutationModulePurity("libs/demo/inf/src/bad-ext.ts", badExtends)
    match(resExtends)
      .with({ _tag: "Excluded" }, ({ reason }) => {
        expect(reason).toContain("nodeSyncHostIo")
      })
      .with({ _tag: "Pure" }, () => expect.unreachable("Expected Excluded"))
      .exhaustive()

    const badContextExtends = [
      'import { Context } from "effect"',
      "declare function mkId(io: unknown): string",
      "export class BadTag extends Context.Service<BadTag, { readonly run: () => void }>()(mkId(nodeExtendedHostIo)) {}",
    ].join("\n")
    const resContextExtends = classifyMutationModulePurity(
      "libs/demo/inf/src/bad-ctx-ext.ts",
      badContextExtends,
    )
    match(resContextExtends)
      .with({ _tag: "Excluded" }, ({ reason }) => {
        expect(reason).toContain("nodeExtendedHostIo")
      })
      .with({ _tag: "Pure" }, () => expect.unreachable("Expected Excluded"))
      .exhaustive()

    const badLayerExtends = [
      "export class BadLayerExt extends Layer.effect(Tag, Effect.void) {}",
    ].join("\n")
    const resLayerExtends = classifyMutationModulePurity(
      "libs/demo/inf/src/bad-layer-ext.ts",
      badLayerExtends,
    )
    match(resLayerExtends)
      .with({ _tag: "Excluded" }, ({ reason }) => {
        expect(reason).toContain("Layer")
      })
      .with({ _tag: "Pure" }, () => expect.unreachable("Expected Excluded"))
      .exhaustive()

    const pureImplementsAndTypeArgs = [
      'import { Schema } from "effect"',
      "interface PureShape<T> { readonly tag?: T | undefined }",
      "export class PureErr extends Schema.TaggedError<PureErr>()('PureErr', { msg: Schema.String }) {}",
      "export class PureImpl implements PureShape<typeof nodeSyncHostIo> { readonly getTag = (): typeof nodeSyncHostIo | undefined => undefined }",
      "export class PureGenericBase<T> { readonly getVal = (): T | undefined => undefined }",
      "export class PureSub extends PureGenericBase<typeof nodeSyncHostIo> { readonly ok = 1 }",
    ].join("\n")
    expect(
      classifyMutationModulePurity("libs/demo/inf/src/pure-class.ts", pureImplementsAndTypeArgs),
    ).toEqual({ _tag: "Pure" })

    // Verify real workspace pure modules remain cleanly discoverable
    const realInfraFiles = findDomainFiles(REAL_REPO_ROOT, testHostIo, "@harness/infra").map(
      (f) => f.relFile,
    )
    expect(realInfraFiles).toContain("libs/harness/infra/src/workflow/writer-lease-codec.ts")
    expect(realInfraFiles).toContain("libs/harness/infra/src/workflow/workflow-store-codec.ts")
    expect(realInfraFiles).toContain("libs/harness/infra/src/workflow/message-storage-codec.ts")
  })

  it("F-10.1: excludes Effect v4 I/O subpath packages and prefixes while preserving pure effect subpaths", () => {
    const disallowedEffectSubpaths = [
      "effect/http",
      "effect/http/HttpClient",
      "effect/http-api",
      "effect/http-api/HttpApi",
      "effect/process",
      "effect/process/ChildProcess",
      "effect/rpc",
      "effect/rpc/RpcClient",
      "effect/cli",
      "effect/cli/Command",
      "effect/socket",
      "effect/socket/Socket",
      "effect/net",
      "effect/net/Tcp",
      "effect/workers",
      "effect/workers/Worker",
      "effect/persistence",
      "effect/persistence/Persistence",
      "effect/eventlog",
      "effect/eventlog/EventLog",
      "effect/Stdio",
      "effect/Stdio/Stdio",
      "effect/devtools",
      "effect/devtools/DevTools",
      "effect/workflow/WorkflowEngine",
      "effect/unstable/sql",
      "effect/unstable/http/HttpClient",
    ]
    for (const pkg of disallowedEffectSubpaths) {
      const src = `import * as Mod from "${pkg}"\nexport const x = Mod\n`
      const res = classifyMutationModulePurity("libs/demo/inf/src/subpath.ts", src)
      match(res)
        .with({ _tag: "Excluded" }, ({ reason }) => {
          expect(reason, pkg).toContain(pkg)
        })
        .with({ _tag: "Pure" }, () => {
          expect.unreachable(`Expected Excluded for ${pkg}`)
        })
        .exhaustive()
    }

    const namedStdioSrc = `import { Stdio } from "effect"\nexport const s = Stdio\n`
    match(classifyMutationModulePurity("libs/demo/inf/src/stdio-root.ts", namedStdioSrc))
      .with({ _tag: "Excluded" }, ({ reason }) => {
        expect(reason).toContain("Stdio")
      })
      .with({ _tag: "Pure" }, () => expect.unreachable("Expected Excluded for effect Stdio"))
      .exhaustive()

    for (const purePkg of ["effect/Schema", "effect/Effect", "effect/Option"]) {
      const src = `import * as Mod from "${purePkg}"\nexport const ok = (x: unknown) => Boolean(Mod) && x !== null\n`
      expect(
        classifyMutationModulePurity("libs/demo/inf/src/pure-subpath.ts", src),
        purePkg,
      ).toEqual({
        _tag: "Pure",
      })
    }
  })
})
