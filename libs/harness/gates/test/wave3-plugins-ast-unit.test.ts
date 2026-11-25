import { describe, expect, it } from "vitest"
import { ts } from "@harness/graph"
import {
  collectEffectPromiseAliases,
  isUnhandledEffectPromiseCall,
} from "../src/plugins/ast-effect-promise-law.js"
import {
  collectWave3FailClosedViolations,
  findAstMatch,
  isProvisionTapErrorRollback,
  isSilentDecodeOrStoreFallback,
} from "../src/plugins/ast-fail-closed-laws.js"
import { findWorkflowFenceViolation } from "../src/plugins/ast-workflow-fence-law.js"
import { collectSilentEffectSwallowViolations } from "../src/plugins/ast-wave3-laws.js"
import {
  getStatementsFromContainer,
  inspectPayloadFlags,
  isDirectDaemonWorkflowInterruptCall,
  isUnguardedWorkflowStatusUpdateCall,
  isWorkflowStoreInvokeCall,
  resolvePayloadObjectLiteral,
  resolveScopedBindingInitializer,
  resolveScopedInitializer,
} from "../src/plugins/ast-workflow-status-law.js"

const parseTs = (code: string, fileName = "libs/demo/domain/src/x.ts"): ts.SourceFile =>
  ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const collectCalls = (sf: ts.SourceFile): Array<ts.CallExpression> => {
  const calls: Array<ts.CallExpression> = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) calls.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return calls
}

describe("wave3 plugins ast quick-wins & fail-closed laws", () => {
  it("ast-effect-promise-law handles namespace destructuring filtering Effect and promise aliases", () => {
    const sf = parseTs(`
import * as effNs from "effect"
const { Option: Opt, Effect: EffAlias, Effect: { promise: p1, succeed: s1 } } = effNs
export const run = () => {
  const a = [Opt.promise(() => 1), EffAlias.promise(() => 2), p1(() => 3)]
  const b = s1(4)
  return [a, b]
}
`)
    const aliases = collectEffectPromiseAliases(sf)
    const hitLines = collectCalls(sf)
      .filter((c) => isUnhandledEffectPromiseCall(c, aliases))
      .map((c) => sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1)
    expect(hitLines).toEqual([5, 5])
  })

  it("ast-workflow-fence-law covers shorthand lease epoch, preceding verifyOffline, wrapper forward, and exempt/spread flags", () => {
    const sfNormal = parseTs(
      `
export const fn = (expectedLeaseEpoch: number, otherProp: number, spreadVar: Record<string, unknown>, opaque: unknown) => {
  otherFn({ expectMutation: true })
  WorkflowStore.invoke()
  invokeWorkflowStoreQuery({ expectMutation: true, queryName: "wf_insert_writer_lease" })
  invokeWorkflowStoreQuery({ ...spreadVar, expectMutation: false })
  invokeWorkflowStoreQuery({ ...spreadVar })
  invokeWorkflowStoreQuery({ expectMutation: true, queryName: "mut", expectedLeaseEpoch })
  invokeWorkflowStoreQuery({ expectMutation: true, queryName: "mut", otherProp })
  if (true) {
    verifyOfflineClusterAccess()
    if (true) { invokeWorkflowStoreQuery(opaque) }
  }
}
export const fnUnguarded = (opaque: unknown) => {
  someOtherVerify()
  invokeWorkflowStoreQuery(opaque)
}
`,
      "libs/demo/domain/src/f.ts",
    )
    const normalRules = collectCalls(sfNormal).flatMap((c) => {
      const v = findWorkflowFenceViolation(c, sfNormal, "libs/demo/domain/src/f.ts")
      return v
        ? [`${v.rule}@${sfNormal.getLineAndCharacterOfPosition(c.getStart(sfNormal)).line + 1}`]
        : []
    })
    expect(normalRules).toEqual([
      "omnigraph-fenced-mutation@7",
      "omnigraph-fenced-mutation@9",
      "omnigraph-fenced-mutation@17",
    ])

    const sfStore = parseTs(
      `
export const invokeWorkflowStoreQuery = (input: unknown) => {
  if (true) { return invokeWorkflowStoreQueryOnce(input) }
  const input2 = input
  invokeWorkflowStoreQueryOnce(input2)
  const fnNoParam = () => {
    const input = make()
    return invokeWorkflowStoreQueryOnce(input)
  }
  return [fnNoParam, otherHelper(input)]
}
`,
      "libs/harness/infra/src/omnigraph-workflow-store.ts",
    )
    const storeLines = collectCalls(sfStore).flatMap((c) =>
      findWorkflowFenceViolation(c, sfStore, "libs/harness/infra/src/omnigraph-workflow-store.ts")
        ? [sfStore.getLineAndCharacterOfPosition(c.getStart(sfStore)).line + 1]
        : [],
    )
    expect(storeLines).toEqual([5, 8])
  })

  it("ast-fail-closed-laws covers stopFn findAstMatch, alias destructuring, bare imports, uncurried decodeOption, and silent/tapError paths", () => {
    const sfStop = parseTs(
      `const outer = (x: number) => { const inner = () => { return x }; return x }`,
    )
    const outerStmt = sfStop.statements[0]!
    const outerArrow = ts.isVariableStatement(outerStmt)
      ? outerStmt.declarationList.declarations[0]!.initializer!
      : outerStmt
    expect(findAstMatch(outerArrow, ts.isArrowFunction, true)).toBe(true)
    const nestedOnlySf = parseTs(`const a = (x: number) => { const b = () => { return x }; }`)
    expect(findAstMatch(nestedOnlySf, ts.isReturnStatement, true)).toBe(false)

    const sfCleanNullish = parseTs(`export const n = (x: string | undefined) => x ?? "ok"`)
    let sawCleanNullish = false
    const scanClean = (n: ts.Node): void => {
      if (isSilentDecodeOrStoreFallback(n, sfCleanNullish)) sawCleanNullish = true
      ts.forEachChild(n, scanClean)
    }
    scanClean(sfCleanNullish)
    expect(sawCleanNullish).toBe(false)

    const sfLaws = parseTs(
      `
import * as EffAll from "effect"
import { catchTag } from "effect/Effect"
const { Option: OptAlias, Effect: EAlias } = EffAll
export function bareAndAlias() {
  const b1 = catchTag("WorkflowStoreUnavailableError", () => EAlias.succeed(undefined))
  const b2 = OptAlias.succeed(undefined)
  const b3 = EAlias.catchTag("WorkflowStoreUnavailableError", () => EAlias.sync(fnRef))
  const b4 = EAlias.catchTag("WorkflowStoreUnavailableError", () => myEff)
  const b5 = EAlias.catchTag("WorkflowStoreUnavailableError", () => EAlias.gen(function* () { yield* EAlias.log("ok") }))
  const b6 = EAlias.catchTag("WorkflowStoreUnavailableError", () => EAlias.gen(function* () { yield* otherOp() }))
  const b7 = Schema.decodeOption(S, raw) ?? null
  const b8 = Schema.decodeOption(S, raw).pipe(Option.getOrUndefined) ?? null
  const b9 = Schema.decodeOption(S, raw).pipe((x) => x) ?? null
  const b10 = EAlias.catchTags(myEff, { WorkflowStoreUnavailableError: () => EAlias.void, IgnoredTag: () => EAlias.void })
  const b11 = EAlias.catchTags({ OtherTag: () => EAlias.void })
  return [b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11]
}
export class ProvisionSvc {
  provisionResource() {
    return [
      myEff.pipe(EAlias.tapError(namedCb)),
      EAlias.tapError(myEff, () => cleanup()),
      EAlias.tapError(myEff, () => EAlias.log("ok")),
    ]
  }
}
`,
      "libs/demo/domain/src/laws.ts",
    )
    const silentLines: Array<number> = []
    const tapLines: Array<number> = []
    const walk = (n: ts.Node): void => {
      if (isSilentDecodeOrStoreFallback(n, sfLaws)) {
        silentLines.push(sfLaws.getLineAndCharacterOfPosition(n.getStart(sfLaws)).line + 1)
      }
      if (ts.isCallExpression(n) && isProvisionTapErrorRollback(n, sfLaws)) {
        tapLines.push(sfLaws.getLineAndCharacterOfPosition(n.getStart(sfLaws)).line + 1)
      }
      ts.forEachChild(n, walk)
    }
    walk(sfLaws)
    expect(silentLines).toEqual([6, 10, 12, 13, 15])
    expect(tapLines).toEqual([22, 23])
  })

  it("collectWave3FailClosedViolations covers backslash escapers, wildcard regexes, padStart, sentinels, and var/git scoping", () => {
    const sf = parseTs(
      `
const sharedGitArgs = ["log", dynRef]
export function execSuite(pat: string, rawGlob: string) {
  const rOk1 = new RegExp(pat.replace(/[*?]/g, (c) => "\\\\" + c))
  const rOk2 = new RegExp(pat.replace(/[*?]/g, (c) => { return "\\\\" + c }))
  const rOk3 = new RegExp(pat.replace(/[*?]/g, (c) => \`\\\\\${c}\`))
  const rOk4 = new RegExp(pat.replace(/[*?]/g, "\\\\$&"))
  const rOkRe = new RegExp(pat.replace(/\\[*?\\]/g, "\\\\$&"))
  const rBadSplit = new RegExp(pat.split("*").join(""))
  const rBad1 = new RegExp(pat.replace(/[*?]/g, () => "\\\\x"))
  const rBad2 = new RegExp(pat.replace(/[*?]/g, (c) => { const y = c; return "\\\\" + y }))
  const rBad3 = new RegExp(pat.replace(/[*?]/g, (c) => "!" + c))
  const rBad4 = new RegExp(pat.replace(/[*?]/g, (c) => \`\\\\\${c}!\`))
  const rBad5 = new RegExp(pat.replace(/[*?]/g, (c) => \`!\${c}\`))
  const rBad6 = new RegExp(pat.replace(/[*?]/g, (c) => { if (c) return "\\\\" + c; return c }))
  const rBad7 = new RegExp(pat.replace(/[*?]/g, (c) => c + "\\\\"))
  const rBad8 = new RegExp(pat.replace(/[*?]/g, (c) => "\\\\" + rawGlob))
  const rBad9 = new RegExp(pat.replace(/[*?]/g, (c) => \`\\\\\${rawGlob}\`))
  const rBad10 = new RegExp(pat.replaceAll("*", ""))
  const rBad11 = new RegExp(pat.split("foo").join(""))
  const rClean = new RegExp(pat.replace("literal", "x"))
  const sentNested = "0".repeat(32) + "0".repeat(32)
  const padHit = "00".padStart(64, "0")
  const padSmall = "00".padStart(1, "0")
  const padMiss = "abc".padStart(64, "0")
  if (true) {
    var hoistedGit = ["log", rawGlob]
  }
  execGit(sharedGitArgs)
  execGit(hoistedGit)
  const obj = { matchGlob() { return new RegExp(rawGlob) } }
  return [rOk1, rOk2, rOk3, rOk4, rOkRe, rBadSplit, rBad1, rBad2, rBad3, rBad4, rBad5, rBad6, rBad7, rBad8, rBad9, rBad10, rBad11, rClean, sentNested, padHit, padSmall, padMiss, obj]
}
`,
      "libs/demo/domain/src/fail.ts",
    )

    const violations = collectWave3FailClosedViolations(sf, "libs/demo/domain/src/fail.ts").map(
      (v) => `${v.rule}@${sf.getLineAndCharacterOfPosition(v.node.getStart(sf)).line + 1}`,
    )
    expect(violations.filter((v) => v.startsWith("fabricated-sentinel-hash"))).toHaveLength(2)
    expect(violations).toContain("unsafe-dynamic-git-ref@29")
    expect(violations).toContain("unsafe-dynamic-git-ref@30")
    expect(violations).toContain("dynamic-glob-regexp@31")
    expect(violations.filter((v) => v.startsWith("dynamic-glob-regexp"))).toHaveLength(12)
  })

  it("collectSilentEffectSwallowViolations covers wrappers, mutations, depth-4 locals, asVoid, data-first/piped, and catchTags", () => {
    const sfCore = parseTs(
      `
import { ignore as directIgnore } from "effect/Effect"
const keptRef = Effect.ignore
const objVal = { k: Effect.ignore }
const okObjKey = { ignore: 1 }
export const testWrappersAndMutations = (cond: boolean, eff: unknown, nonFn: unknown, spreadMore: Record<string, unknown>) => {
  let n = 0
  const okSync = Effect.ignore(Effect.sync(() => { const b = n < 1; Effect.log("x"); return b }))
  const okTry = Effect.ignore(Effect.try(() => Effect.log("x")))
  const okSusp = Effect.ignore(Effect.suspend(() => Effect.log("x")))
  const okTap = Effect.ignore(Effect.tap(() => Effect.log("x")))
  const badInc = Effect.ignore(Effect.sync(() => { ++n; return Effect.log("x") }))
  const badDec = Effect.ignore(Effect.sync(() => { --n; return Effect.log("x") }))
  const badAdd = Effect.ignore(Effect.sync(() => { n += 1; return Effect.log("x") }))
  const badLastAssign = Effect.ignore(Effect.sync(() => { n ^= 1; return Effect.log("x") }))
  const badCall = Effect.ignore(Effect.sync(() => other()))
  const badDirectIgnore = directIgnore(eff)
  const okHop5 = eff.pipe(Effect.orElseSucceed(() => { const a = undefined; const b = a; const c = b; const d = c; const e = d; return e }))
  const badHop3 = eff.pipe(Effect.orElseSucceed(() => { const a = undefined; const b = a; const c = b; const f = () => { return 1 }; return c }))
  const badHopNull = eff.pipe(Effect.orElseSucceed(() => { const a = undefined; const b = a; const c = b; const d = c; return d }))
  const badEmptyRet = eff.pipe(Effect.orElseSucceed(() => { ; return }))
  const badEmptyOrElse = eff.pipe(Effect.orElseSucceed(() => {}))
  const okNonFnOrElse = eff.pipe(Effect.orElseSucceed(nonFn))
  const badZeroSucceed = eff.pipe(Effect.catch(() => Effect.succeed()))
  const badVoidSync = eff.pipe(Effect.catch(() => Effect.sync(() => void 0)))
  const badVoidGen = eff.pipe(Effect.catch(() => Effect.gen(function* () { return })))
  const badAsVoidSucc = eff.pipe(Effect.catch(() => Effect.asVoid(Effect.succeed(1))))
  const badAsVoidSync = eff.pipe(Effect.catch(() => Effect.asVoid(Effect.sync(() => 1))))
  const okAsVoidZero = eff.pipe(Effect.catch(() => Effect.asVoid()))
  const badPipeSucc = eff.pipe(Effect.catch(() => pipe(Effect.succeed(1), Effect.asVoid)))
  const badPipeSync = eff.pipe(Effect.catch(() => Effect.sync(() => 1).pipe(Effect.asVoid)))
  const badPipeCall = eff.pipe(Effect.catch(() => Effect.sync(() => 1).pipe(Effect.asVoid())))
  const badNestedLogOnly = eff.pipe(Effect.catch(() => { const f = () => Effect.log("in"); return Effect.void }))
  const okNonFnCatch = Effect.catch(eff, nonFn)
  const okStmtBlockCatch = Effect.catch(eff, () => { doWork() })
  const okNestedRetOuterEff = Effect.catch(eff, () => { const f = () => Effect.void; return realEff() })
  const okNestedFnReturn = Effect.catch(eff, () => { const f = () => { return }; return realEff() })
  const okTernaryVal = Effect.catch(eff, () => cond ? realEff() : realVal)
  const badOrElseDataFirst = Effect.orElseSucceed(eff, () => undefined)
  const badCatchTagDataFirst = Effect.catchTag(eff, "E", () => Effect.void)
  const badCatchTagsMethod = Effect.catchTags(eff, { E() { return Effect.void } })
  const okCatchTagsSpread = Effect.catchTags(eff, { ...spreadMore })
  const okPipeClean = Effect.log("pre").pipe(Effect.tap(() => Effect.log("y")), Effect.ignore)
  const badYieldVoidGen = Effect.catch(eff, () => Effect.gen(function* () { return yield* Effect.void }))
  return [keptRef, objVal, okObjKey, okSync, okTry, okSusp, okTap, badInc, badDec, badAdd, badLastAssign, badCall, badDirectIgnore, okHop5, badHop3, badHopNull, badEmptyRet, badEmptyOrElse, okNonFnOrElse, badZeroSucceed, badVoidSync, badVoidGen, badAsVoidSucc, badAsVoidSync, okAsVoidZero, badPipeSucc, badPipeSync, badPipeCall, badNestedLogOnly, okNonFnCatch, okStmtBlockCatch, okNestedRetOuterEff, okNestedFnReturn, okTernaryVal, badOrElseDataFirst, badCatchTagDataFirst, badCatchTagsMethod, okCatchTagsSpread, okPipeClean, badYieldVoidGen]
}
`,
      "libs/demo/core/src/sw.ts",
    )
    const coreLines = collectSilentEffectSwallowViolations(sfCore, "libs/demo/core/src/sw.ts").map(
      (v) => sfCore.getLineAndCharacterOfPosition(v.node.getStart(sfCore)).line + 1,
    )
    expect(coreLines).toEqual([
      4, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 24, 25, 26, 27, 28, 30, 31, 32, 33, 39, 40, 41, 44,
      45,
    ])

    const sfComp = parseTs(
      `
export class Cmp {
  compensateStep(eff: unknown) {
    return eff.pipe(Effect.ignore)
  }
}
export function nonComp(eff: unknown) {
  return eff.pipe(Effect.ignore)
}
`,
      "libs/demo/infra/src/comp.ts",
    )
    const compLines = collectSilentEffectSwallowViolations(
      sfComp,
      "libs/demo/infra/src/comp.ts",
    ).map((v) => sfComp.getLineAndCharacterOfPosition(v.node.getStart(sfComp)).line + 1)
    expect(compLines).toEqual([4])
  })

  it("ast-workflow-status-law resolves scoped bindings, payload literals, and nested spread flags", () => {
    const sfCalls = parseTs(
      `WorkflowStore["invoke"]({}); WorkflowStore["invokeWithMeta"]({}); (() => {})(); Other.invoke({});`,
    )
    expect(collectCalls(sfCalls).map((c) => isWorkflowStoreInvokeCall(c))).toEqual([
      true,
      true,
      false,
      false,
    ])

    const sfContainers = parseTs(
      `namespace M { export const nsV = 1 }
switch (x) { case 1: break; default: break }`,
    )
    let modLen: number | undefined
    let caseLen: number | undefined
    let defLen: number | undefined
    let idLen: number | undefined
    const visitContainers = (n: ts.Node): void => {
      if (ts.isModuleBlock(n)) modLen = getStatementsFromContainer(n)?.length
      if (ts.isCaseClause(n)) caseLen = getStatementsFromContainer(n)?.length
      if (ts.isDefaultClause(n)) defLen = getStatementsFromContainer(n)?.length
      if (ts.isIdentifier(n) && idLen === undefined) idLen = getStatementsFromContainer(n)?.length
      ts.forEachChild(n, visitContainers)
    }
    visitContainers(sfContainers)
    expect([
      getStatementsFromContainer(sfContainers)?.length,
      modLen,
      caseLen,
      defLen,
      idLen,
    ]).toEqual([2, 1, 1, 1, undefined])

    const sfBindings = parseTs(`const firstVar = { x: 1 }
let uninit
const other = 1
const { a: otherAlias, b: targetAlias } = { a: 1, b: 2 }
function wrap() {
  const refFirst = firstVar
  const refDestr = targetAlias
  const refUninit = uninit
  return [refFirst, refDestr, refUninit]
}`)
    const refNodes = new Map<string, ts.Identifier>()
    const collectRefs = (n: ts.Node): void => {
      if (
        ts.isIdentifier(n) &&
        n.parent !== undefined &&
        ts.isVariableDeclaration(n.parent) &&
        n.parent.initializer === n
      ) {
        refNodes.set(n.text, n)
      }
      ts.forEachChild(n, collectRefs)
    }
    collectRefs(sfBindings)
    expect(
      resolveScopedBindingInitializer("firstVar", sfBindings.statements[0]!, sfBindings),
    ).toBeUndefined()
    expect(
      resolveScopedBindingInitializer("firstVar", refNodes.get("firstVar")!, sfBindings)
        ?.isDestructured,
    ).toBe(false)
    expect(
      resolveScopedBindingInitializer("targetAlias", refNodes.get("targetAlias")!, sfBindings),
    ).toMatchObject({ isDestructured: true, propName: "b" })
    expect(
      resolveScopedInitializer("targetAlias", refNodes.get("targetAlias")!, sfBindings),
    ).toBeUndefined()
    expect(resolveScopedInitializer("uninit", refNodes.get("uninit")!, sfBindings)).toBeUndefined()

    const sfPayloads = parseTs(`const p1 = { expectMutation: true }
const p2 = p1
const p3 = p2
const p4 = p3
const p5 = p4
const pUnknown = unknownExternal
invoke(p1); invoke(p4); invoke(p5); invoke(pUnknown); invoke(123)`)
    const payloadCalls = collectCalls(sfPayloads)
    expect(
      payloadCalls.map(
        (c) => resolvePayloadObjectLiteral(c.arguments[0]!, c, sfPayloads) !== undefined,
      ),
    ).toEqual([true, true, false, false, false])

    const sfFlags = parseTs(`const t1 = true; const t2 = t1; const t3 = t2; const t4 = t3
const n1 = false; const n2 = n1; const n3 = n2; const n4 = n3; const n5 = n4
const expectMutation = false
const otherProp = true
const s3 = { expectMutation: false, queryName: "wf_insert_writer_lease" }
const s2 = { ...s3 }
const s1 = { ...s2 }
const s0 = { ...s1 }
const kBase = { expectMutation: false, queryName: "wf_insert_writer_lease" }
const cases = [
  { expectMutation: true },
  { expectMutation: false },
  { expectMutation: unknownFlag },
  { expectMutation: t4 },
  { expectMutation: n4 },
  { expectMutation: n5 },
  { otherProp, expectMutation, queryName },
  { other: true, expectMutation: false, queryName: "wf_insert_writer_lease" },
  { ...kBase },
  { ...unknownSpread },
  { ...s1 },
  { ...s0 },
]
const laterCases = (() => {
  const queryName = "wf_insert_writer_lease"
  return [{ otherProp }, { queryName }]
})()`)
    const flagObjs: Array<ts.ObjectLiteralExpression> = []
    const walkObjs = (n: ts.Node): void => {
      if (ts.isArrayLiteralExpression(n)) {
        for (const el of n.elements) {
          if (ts.isObjectLiteralExpression(el)) flagObjs.push(el)
        }
      }
      ts.forEachChild(n, walkObjs)
    }
    walkObjs(sfFlags)
    const inspected = flagObjs.map((o) => inspectPayloadFlags(o, sfFlags))
    expect(
      inspected.map((r) => [
        r.hasExpectMutationTrue,
        r.hasExpectMutationFalse,
        r.hasQueryName,
        r.isExemptLeaseQuery,
        r.hasUnresolvedSpread,
      ]),
    ).toEqual([
      [true, false, false, false, false],
      [false, true, false, false, false],
      [true, false, false, false, false],
      [true, false, false, false, false],
      [false, true, false, false, false],
      [true, false, false, false, false],
      [false, true, true, false, false],
      [false, true, true, true, false],
      [false, true, true, true, false],
      [false, false, false, false, true],
      [false, true, true, true, false],
      [false, false, false, false, true],
      [false, false, false, false, false],
      [false, false, true, true, false],
    ])
  })

  it("isDirectDaemonWorkflowInterruptCall handles helpers, settle calls, destructuring, and alias depth", () => {
    const daemonCode = `export function interruptAndSettleGood() {
  shipWorkflow.interrupt()
  waitBoundedUntil()
}
export function interruptAndSettleCancel() {
  shipWorkflow.interrupt()
  cancelAndAwait()
}
export function interruptAndSettleBad() {
  shipWorkflow.interrupt()
  unrelatedCall()
}
export function interruptChainCases(deps) {
  const w1 = shipWorkflow
  w1.interrupt()
  const a0 = shipWorkflow
  const a1 = a0
  const a2 = a1
  const a3 = a2
  const a4 = a3
  const a5 = a4
  a5.interrupt()
  const { shipWorkflow: sw, otherDep: od } = deps
  sw.interrupt()
  od.interrupt()
  unboundThing.interrupt()
  getRunner().interrupt()
  const { interrupt: intr, resume: res } = shipWorkflow
  intr()
  res()
  const dIntr = shipWorkflow.interrupt
  const dRes = shipWorkflow.resume
  dIntr()
  dRes()
  const fnRef = getHandler()
  fnRef()
  ;(() => {})()
}`
    const sfDaemon = parseTs(daemonCode, "apps/harness-mcp/src/daemon/d.ts")
    const flaggedLines = collectCalls(sfDaemon)
      .filter((c) =>
        isDirectDaemonWorkflowInterruptCall(c, sfDaemon, "apps/harness-mcp/src/daemon/d.ts"),
      )
      .map((c) => sfDaemon.getLineAndCharacterOfPosition(c.getStart(sfDaemon)).line + 1)
    expect(flaggedLines).toEqual([10, 15, 24, 29, 33])

    const sfOther = parseTs(`shipWorkflow.interrupt()`, "libs/harness/gates/src/other.ts")
    expect(
      collectCalls(sfOther).some((c) =>
        isDirectDaemonWorkflowInterruptCall(c, sfOther, "libs/harness/gates/src/other.ts"),
      ),
    ).toBe(false)
  })

  it("isUnguardedWorkflowStatusUpdateCall covers exempt path, payload params, updateStatus fns, and transparent callbacks", () => {
    const sfExempt = parseTs(
      `invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true })`,
      "/repo/libs/harness/infra/src/omnigraph-workflow-store.ts",
    )
    expect(
      collectCalls(sfExempt).some((c) => isUnguardedWorkflowStatusUpdateCall(c, sfExempt)),
    ).toBe(false)

    const code = `const other = "x"
const queryName = "wf_update_ship_attempt"
export function topCases() {
  invokeWorkflowStoreQuery({ expectMutation: true })
  invokeWorkflowStoreQuery({ queryName: "wf_insert_step", expectMutation: true })
  invokeWorkflowStoreQuery({ other, queryName, expectMutation: true })
  invokeWorkflowStoreQuery({ other, expectMutation: true })
}
export function otherFn() {
  invokeWorkflowStoreQuery({ queryName: "wf_update_run", expectMutation: true, params: { status: "done" } })
}
export function updateRunStatus(status: string, note: string, dynParams: Record<string, unknown>) {
  invokeWorkflowStoreQuery({ queryName: "wf_update_run", expectMutation: true, params: { other: 1, status: "done" } })
  invokeWorkflowStoreQuery({ queryName: "wf_update_run", expectMutation: true, params: { status } })
  invokeWorkflowStoreQuery({ queryName: "wf_update_run", expectMutation: true, extra: { status: "done" }, params: { note: "x" } })
  invokeWorkflowStoreQuery({ queryName: "wf_update_run", expectMutation: true, params: { note } })
  invokeWorkflowStoreQuery({ queryName: "wf_update_run", expectMutation: true, params: dynParams })
}
export function testCallbacks(eff, row, handlers) {
  const curStatus = row.status
  Effect.gen((function* () { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }))
  pipe(eff, () => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  Effect.fn(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  Effect.fnUntraced(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  Effect.fn("s")(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  Effect.fnUntraced("s")(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  function innerDecl() { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
  const deferred = () => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
  OtherNs.fn(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  Effect.catchAll(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  OtherNs.fn("s")(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  Effect.catchAll("s")(() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  handlers["onRun"](() => { if (curStatus !== "running") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) })
  return [innerDecl, deferred]
}`
    const sf = parseTs(code, "libs/harness/infra/src/runner.ts")
    const flaggedLines = collectCalls(sf)
      .filter((c) => isUnguardedWorkflowStatusUpdateCall(c, sf))
      .map((c) => sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1)
    expect(flaggedLines).toEqual([6, 13, 14, 27, 28, 29, 30, 31, 32, 33])
  })

  it("isUnguardedWorkflowStatusUpdateCall covers receivers, equality operators, .has, Effect.fail, match, and control flow", () => {
    const code = `export function gRecvBad(ctx) { if (ctx.response.status !== "ok") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gRecvOk() { if (getRow().status !== "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gAliasBad(row) { const notS = row.state; if (notS !== "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gAliasOk(row) { const okS = row.status; if (okS !== "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gMemBad(row) { if (row.state !== "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gOpLt(row) { if (row.status < "z") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gOpEq3(row) { if (row.status === "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gOpNeq3(row) { if (row.status !== "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gOpEq2(row) { if (row.status == "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gOpNeq2(row) { if (row.status != "done") return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gHasOk(row) { if (!ALLOWED.has(row.status)) return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gHasBadName(row) { if (!ALLOWED.includes(row.status)) return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gHasBadArgs(row) { if (!ALLOWED.has()) return; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gFailOk(row) { if (row.status !== "done") { Effect.fail("e") } invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gFailCauseOk(row, c) { if (row.status !== "done") { Effect.failCause(c) } invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gDieOk(row) { if (row.status !== "done") { Effect.die("d") } invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gFailBadNs(row) { if (row.status !== "done") { OtherNs.fail("e") } invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gFailBadLog(row) { if (row.status !== "done") { Effect.log("w") } invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gNestedFnBad(row) { const h = () => { if (row.status !== "done") return }; invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }); return h }
export function gMatchStmtOk(row) { match(row.status).with("done", () => Effect.fail("e")).exhaustive(); invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gMatchStmtBad() { match().with("done", () => Effect.fail("e")).exhaustive(); invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }
export function gEncloseIfOk(row) { if (row.status === "running") { invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) } }
export function gEncloseIfBad(row) { if (row.status === "running" || invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true })) {} }
export function gEncloseTernaryOk(row) { return row.status === "running" ? invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) : null }
export function gEncloseTernaryBad(row) { return (row.status === "running" && invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true })) ? 1 : 0 }
export function gEncloseMatchOk(row) { return match(row.status).with("running", () => invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true })).exhaustive() }
export function gEmptyThenBad(row) { if (row.status !== "running") {} invokeWorkflowStoreQuery({ queryName: "wf_update_ship_attempt", expectMutation: true }) }`
    const sf = parseTs(code, "libs/harness/infra/src/guards.ts")
    const flaggedLines = collectCalls(sf)
      .filter((c) => isUnguardedWorkflowStatusUpdateCall(c, sf))
      .map((c) => sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1)
    expect(flaggedLines).toEqual([1, 3, 5, 6, 12, 13, 17, 18, 19, 21, 23, 25, 27])
  })
})
