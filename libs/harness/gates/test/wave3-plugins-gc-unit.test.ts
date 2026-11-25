import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  WORKER_ISOLATION_PARITY_DOC_PATHS,
  auditWorkerIsolationSubcommandParity,
} from "../src/plugins/gc/gc-catalog-doc-truth.js"
import { checkAlwaysPopulatedOptionalRuntimeProps } from "../src/plugins/gc/gc-runtime-props.js"
import { WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS } from "../src/policy-worker-isolation.js"
import { isolatedTestHostIo } from "./helpers/test-host-io.js"

const tempDirs: Array<string> = []
const makeTempRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wave3-plugins-gc-"))
  tempDirs.push(dir)
  return dir
}

const writeRepoFile = (repoRoot: string, relPath: string, content: string): void => {
  const full = join(repoRoot, relPath)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content, "utf8")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("wave3 plugins gc unit tests", () => {
  it("auditWorkerIsolationSubcommandParity reads multiline window and reports exact 1-based line numbers", () => {
    const repo = makeTempRepo()
    const listText = WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join("|")
    writeRepoFile(
      repo,
      "libs/harness/gates/src/policy.ts",
      `const r = \`${"${WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join('|')}"}\`\n`,
    )
    for (const relDoc of WORKER_ISOLATION_PARITY_DOC_PATHS) {
      if (relDoc === "adapters/claude-code/README.md") {
        writeRepoFile(
          repo,
          relDoc,
          `Intro line\nWhen HARNESS_UNIT_WORKER=1 is set:\n\`harness workflow ${listText}\`\n`,
        )
      } else if (relDoc === "adapters/antigravity/plugins/effect-harness/README.md") {
        writeRepoFile(repo, relDoc, "Header\nHARNESS_UNIT_WORKER=1 missing cmd list\n")
      } else {
        writeRepoFile(
          repo,
          relDoc,
          `HARNESS_UNIT_WORKER=1 blocks \`harness workflow ${listText}\`.\n`,
        )
      }
    }

    const findings = auditWorkerIsolationSubcommandParity(repo, isolatedTestHostIo, [])
    expect(findings.map((f) => [f.nodeId, f.location])).toEqual([
      [
        "adapters/antigravity/plugins/effect-harness/README.md:missing-subcmd-list",
        "adapters/antigravity/plugins/effect-harness/README.md:2",
      ],
    ])
  })

  it("checkAlwaysPopulatedOptionalRuntimeProps covers pass-through expressions, libs, reexports, and destructuring", () => {
    const repo = makeTempRepo()
    writeRepoFile(
      repo,
      "libs/demo/contract/src/types.ts",
      `export type LibOpt = { fromLib?: string; undefLib?: (number | undefined); reqLib: string }
export function libMaybe(): string | undefined { return undefined }
export const libUntraced = Effect.fnUntraced((): (string | undefined) => undefined)
export const libTraced = Effect.fn("traced")((): (string | undefined) => undefined)
export const libEffectOther = Effect.other((): (string | undefined) => undefined)
export const libArrow = (): string | undefined => undefined
export const libAlways = (): string | number => 1
export const otherWrapper = OtherNs.fn((): string | undefined => undefined)
`,
    )
    writeRepoFile(
      repo,
      "apps/web/src/base.ts",
      `export type LocalBag = { optKey?: string; "str-key"?: string; reqKey: string }
export function localOptFn(): string | undefined { return undefined }
export const localVarOptFn = (): string | undefined => undefined
export const localUntypedFn = () => "ok"
export const localNonOptFn = (): string => "ok"
`,
    )
    writeRepoFile(
      repo,
      "apps/web/src/reexport.ts",
      `export { LocalBag, localOptFn, localVarOptFn, localUntypedFn, localNonOptFn } from "./base.js"\n`,
    )
    writeRepoFile(repo, "apps/web/src/r1.ts", `export { localOptFn } from "./base.js"\n`)
    writeRepoFile(repo, "apps/web/src/r2.ts", `export { localOptFn } from "./r1.js"\n`)
    writeRepoFile(repo, "apps/web/src/r3.ts", `export { localOptFn } from "./r2.js"\n`)
    writeRepoFile(repo, "apps/web/src/r4.ts", `export { localOptFn } from "./r3.js"\n`)
    writeRepoFile(repo, "apps/web/src/r5.ts", `export { localOptFn } from "./r4.js"\n`)
    writeRepoFile(
      repo,
      "apps/web/src/runtime.ts",
      `import { libMaybe, libUntraced, libTraced, libEffectOther, libArrow, libAlways, otherWrapper, type LibOpt } from "@demo/contract"
import { LocalBag as AliasedBag, localOptFn as aliasedLocalOpt, localVarOptFn, localUntypedFn, localNonOptFn } from "./reexport.js"
import { localOptFn as deepReexpOptFn } from "./r5.js"
import * as ReNs from "./reexport.js"
import * as UnknownNs from "./missing.js"
declare const cond: boolean
declare const arr: Array<{ k: string }>
declare const spreadExtra: Record<string, unknown>
declare const objInline: { inlineOpt?: string }
declare const nestedCallObj: { inner: { run: () => string } }
export interface SoloRuntime {
  alwaysStr?: string
  alwaysFromNonOptFn?: string
  alwaysFromNonUndefUnion?: string | number
  alwaysFromOtherWrapFn?: string | undefined
  alwaysFromEffectOther?: string | undefined
  alwaysFromUntypedFn?: string
  alwaysFromNestedCall?: string
  alwaysFromDeepReexp?: string
  alwaysFromNsNonOpt?: string
  alwaysFromDefaultedParam?: string
  alwaysFromOuterShadow?: string
  alwaysFromReqParam?: string
  alwaysFromReqDestruct?: string
  alwaysNullishLit?: string
  alwaysShorthandReq?: string
  optUndefId?: string
  optVoidExpr?: string
  optNull?: string | null
  optPropChain?: string
  optElemChain?: string
  optParamQ?: string
  optParamDestruct?: string
  optLocalVarUndef?: string
  optLocalDestruct?: string
  optLocalRenameDestruct?: string
  optViaLibMaybe?: string
  optViaLibUntraced?: string
  optViaLibTraced?: string
  optViaLibArrow?: string
  optViaLocalReexpFn?: string
  optViaLocalVarFn?: string
  optViaNsReexpFn?: string
  optViaDeepExpr?: string
  optViaTernary?: string
  optViaNullish?: string
  optViaInlineType?: string
  optSpreadCovered?: string
}
export function makeSolo(
  { fromLib: renamedLib, undefLib, reqLib }: LibOpt,
  { optKey: missingKey, "str-key": defaultedOpt = "fallback", reqKey }: AliasedBag,
  alwaysShorthandReq: string,
  directOpt?: string,
  optParamObj?: { readonly innerKey: string },
): SoloRuntime {
  const outerShadow: string = "always"
  const innerHelper = () => {
    const outerShadow: string | undefined = undefined
    return outerShadow
  }
  const typedUndef: (string | undefined) = UnknownNs.get()
  const { optKey: d1, "str-key": strDestruct, reqKey: dReq }: AliasedBag = objInline as AliasedBag
  const { innerKey: initOptDestruct } = optParamObj
  return {
    optSpreadCovered: "overridden",
    ...spreadExtra,
    alwaysStr: "ok",
    alwaysFromNonOptFn: localNonOptFn(),
    alwaysFromNonUndefUnion: libAlways(),
    alwaysFromOtherWrapFn: otherWrapper(),
    alwaysFromEffectOther: libEffectOther(),
    alwaysFromUntypedFn: localUntypedFn(),
    alwaysFromNestedCall: nestedCallObj.inner.run(),
    alwaysFromDeepReexp: deepReexpOptFn(),
    alwaysFromNsNonOpt: ReNs.localNonOptFn(),
    alwaysFromDefaultedParam: defaultedOpt,
    alwaysFromOuterShadow: outerShadow,
    alwaysFromReqParam: reqLib + reqKey,
    alwaysFromReqDestruct: dReq,
    alwaysNullishLit: "a" + "b",
    alwaysShorthandReq,
    optUndefId: undefined,
    optVoidExpr: void 0,
    optNull: null,
    optPropChain: objInline?.inlineOpt,
    optElemChain: arr?.[0]?.k,
    optParamQ: directOpt,
    optParamDestruct: renamedLib ?? missingKey ?? (undefLib ? String(undefLib) : undefined),
    optLocalVarUndef: typedUndef,
    optLocalDestruct: d1,
    optLocalRenameDestruct: strDestruct ?? initOptDestruct,
    optViaLibMaybe: libMaybe(),
    optViaLibUntraced: libUntraced(),
    optViaLibTraced: libTraced(),
    optViaLibArrow: libArrow(),
    optViaLocalReexpFn: aliasedLocalOpt(),
    optViaLocalVarFn: localVarOptFn(),
    optViaNsReexpFn: ReNs.localOptFn(),
    optViaDeepExpr: optParamObj.innerKey,
    optViaTernary: cond ? "ok" : directOpt,
    optViaNullish: "ok" ?? directOpt,
    optViaInlineType: objInline.inlineOpt,
  }
}
`,
    )

    const findings = checkAlwaysPopulatedOptionalRuntimeProps(repo, isolatedTestHostIo)
    expect(findings.map((f) => f.nodeId)).toEqual([
      "apps/web/src/runtime.ts:SoloRuntime.alwaysStr",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromNonOptFn",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromNonUndefUnion",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromOtherWrapFn",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromEffectOther",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromUntypedFn",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromNestedCall",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromDeepReexp",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromNsNonOpt",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromDefaultedParam",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromOuterShadow",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromReqParam",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysFromReqDestruct",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysNullishLit",
      "apps/web/src/runtime.ts:SoloRuntime.alwaysShorthandReq",
    ])
  })

  it("checkAlwaysPopulatedOptionalRuntimeProps handles Effect.gen, OtherWrap, fnParam calls, test-only types, and spreads", () => {
    const repo = makeTempRepo()
    writeRepoFile(
      repo,
      "apps/web/src/wrappers.ts",
      `declare const OtherWrap: { sync: <T>(f: () => T) => T }
declare const spreadPart: Partial<SpreadLastRuntime>
export interface GenWrapRuntime { alwaysInGen?: string; "opt-key"?: string; req: string }
export const makeGen = (): GenWrapRuntime => {
  function nestedDecl() { return { req: "r" } }
  const nestedArrow = () => { return { req: "r" } }
  Effect.tap(() => { return { req: "r" } })
  return Effect.gen((function* () {
    return { alwaysInGen: "ok", req: "r" }
  })) as unknown as GenWrapRuntime
}
export const makeOtherWrap = (): GenWrapRuntime =>
  OtherWrap.sync(() => {
    return { alwaysInGen: "ignored", "opt-key": "ignored", req: "r" }
  })
export interface ParamRuntime { viaCall?: string; omittedInCall?: string }
export function acceptParam(p: ParamRuntime) { return p }
acceptParam({ viaCall: "v" })
export interface SpreadLastRuntime { coveredBySpread?: string; afterSpread?: string }
export const spreadObj: SpreadLastRuntime = { coveredBySpread: "c", ...spreadPart, afterSpread: "a" }
export interface TestOnlyRuntime { onlyInTest?: string }
`,
    )
    writeRepoFile(
      repo,
      "apps/web/test/wrappers.test.ts",
      `import { type GenWrapRuntime, type TestOnlyRuntime } from "../src/wrappers.js"
export const gTest: GenWrapRuntime = { alwaysInGen: "t", "opt-key": "t", req: "r" }
export const tOnly: TestOnlyRuntime = { onlyInTest: "t" }
`,
    )

    const findings = checkAlwaysPopulatedOptionalRuntimeProps(repo, isolatedTestHostIo)
    expect(findings.map((f) => [f.nodeId, f.location])).toEqual([
      ["apps/web/src/wrappers.ts:GenWrapRuntime.alwaysInGen", "apps/web/src/wrappers.ts:3"],
      ["apps/web/src/wrappers.ts:ParamRuntime.viaCall", "apps/web/src/wrappers.ts:16"],
      ["apps/web/src/wrappers.ts:SpreadLastRuntime.afterSpread", "apps/web/src/wrappers.ts:19"],
    ])
  })
})
