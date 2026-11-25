import { describe, expect, it } from "vitest"
import { Project, ts } from "ts-morph"
import {
  checkDiscriminantAndPredicateBranching,
  checkNodeSqliteInInfra,
  checkNonExhaustiveUnionMatch,
  checkPass0ZeroToleranceAst,
  checkUnscopedEffectRun,
} from "../src/extractor/ast-policy-extractor.js"
import { checkBrandedDomainTypesAndPrimitiveBoundaries } from "../src/extractor/brand-boundary-extractor.js"
import {
  checkDeciderTracing,
  checkMissingAggregateIdGuard,
  resolveSchemasForParameter,
} from "../src/extractor/decider-reducer-extractor.js"
import { extractEffectFns } from "../src/extractor/effect-fn-extractor.js"
import {
  isClosedStringLiteralUnionType,
  isEqualityOpKind,
  isLiteralNode,
  type TaggedSchemaInfo,
} from "../src/extractor/extractor-types-and-helpers.js"
import { splitMarkdownTableCells } from "../src/extractor/governance-markdown-helpers.js"
import { checkEventSourcingReducers } from "../src/extractor/reducer-policy-extractor.js"
import {
  checkSchemaBooleanStateAndBrandedFields,
  extractSchemaDefinitions,
} from "../src/extractor/schema-and-brand-extractor.js"
import { type BranchingViolation, type EffectFnNode, type SchemaDefNode } from "../src/model.js"

const AMBIENT_DTS = `
declare type Branded<T, K extends string> = T & { readonly "~effect/Brand": { readonly [P in K]: true } }
declare interface SchemaType<A> {
  readonly "~type.make": A
  readonly Type: A
  pipe<B>(f: (self: this) => B): B
}
declare const Schema: {
  readonly String: SchemaType<string>
  readonly Number: SchemaType<number>
  readonly Int: SchemaType<number>
  readonly Natural: SchemaType<number>
  readonly Boolean: SchemaType<boolean>
  readonly Literal: <const L extends string>(v: L) => SchemaType<L>
  readonly NullOr: <A>(s: SchemaType<A>) => SchemaType<A | null>
  readonly Option: <A>(s: SchemaType<A>) => SchemaType<Option<A>>
  readonly optional: <A>(s: SchemaType<A>) => SchemaType<A | undefined>
  readonly optionalWith: <A>(s: SchemaType<A>, opts?: unknown) => SchemaType<A | undefined>
  readonly brand: <K extends string>(key: K) => <A>(s: SchemaType<A>) => SchemaType<Branded<A, K>>
  readonly Struct: <F extends Record<string, SchemaType<unknown>>>(fields: F) => SchemaType<{ readonly [P in keyof F]: F[P] extends SchemaType<infer A> ? A : never }>
  readonly TaggedStruct: <Tag extends string, F extends Record<string, SchemaType<unknown>>>(tag: Tag, fields: F) => SchemaType<{ readonly _tag: Tag } & { readonly [P in keyof F]: F[P] extends SchemaType<infer A> ? A : never }>
  readonly TaggedUnion: <M extends Record<string, Record<string, SchemaType<unknown>>>>(m: M) => SchemaType<{ readonly _tag: keyof M }>
  readonly Union: (...m: ReadonlyArray<SchemaType<unknown>>) => SchemaType<unknown>
  TaggedClass<Self>(): <Tag extends string, F extends Record<string, SchemaType<unknown>>>(tag: Tag, fields: F) => { new (): { readonly _tag: Tag } & { readonly [P in keyof F]: F[P] extends SchemaType<infer A> ? A : never } }
  TaggedError<Self>(): <Tag extends string, F extends Record<string, SchemaType<unknown>>>(tag: Tag, fields: F) => { new (args: unknown): { readonly _tag: Tag } & { readonly [P in keyof F]: F[P] extends SchemaType<infer A> ? A : never }; make(args: unknown): { readonly _tag: Tag } }
  Class<Self>(name: string): <F extends Record<string, SchemaType<unknown>>>(fields: F) => { new (): { readonly [P in keyof F]: F[P] extends SchemaType<infer A> ? A : never } }
}
declare const S: typeof Schema
declare namespace Custom {
  export const Struct: typeof Schema.Struct
  export const TaggedStruct: typeof Schema.TaggedStruct
  export const NotStruct: <F extends Record<string, SchemaType<unknown>>>(fields: F) => F
}
declare const Effect: {
  fn: (name?: string) => <F>(f: F) => F
  fnUntraced: <F>(f: F) => F
  succeed: <A>(a: A) => { readonly Type: A }
  fail: <E>(e: E) => { readonly Error: E }
  runSync: <A>(eff: A) => A
  runPromise: <A>(eff: A) => Promise<A>
}
declare const Decider: { make: <O>(opts: O) => O }
declare const PkgDecider: { make: <O>(opts: O) => O }
declare const Layer: { succeed: <A>(t: unknown, v: A) => { readonly LayerTag: true } }
declare const Equal: { equals: (a: unknown, b: unknown) => boolean }
declare const Pkg: { Equal: { equals: (a: unknown, b: unknown) => boolean } }
declare namespace Context {
  export function Service<Self, Shape>(id: string): new () => Shape
}
declare type Option<A> = { readonly _tag: "Some"; readonly value: A } | { readonly _tag: "None" }
declare function match<T>(v: T): {
  with: (...args: ReadonlyArray<unknown>) => ReturnType<typeof match<T>>
  exhaustive: () => unknown
  otherwise: (f: () => unknown) => unknown
}
declare function someWrapper<F>(f: F): F
declare function curriedWrapper(): <F>(f: F) => F
declare const MyDeclaredFault: { make: (x: unknown) => { readonly _tag: "MyDeclaredFault" } }
`

const project = new Project({
  useInMemoryFileSystem: true,
  compilerOptions: {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
})
project.createSourceFile("/ambient.d.ts", AMBIENT_DTS, { overwrite: true })

const makeSf = (relPath: string, code: string) =>
  project.createSourceFile(`/${relPath}`, code, { overwrite: true })

describe("extractor-wave3-unit (in-memory)", () => {
  it("ast-policy-extractor covers zero-tolerance casts, sqlite, branching, unscoped run, and non-exhaustive match", () => {
    const sf1 = makeSf(
      "libs/demo/infra/src/a.ts",
      [
        'import { DatabaseSync } from "node:sqlite"',
        'const a = import("sqlite")',
        'const b = require("better-sqlite3")',
        'const okCall = someWrapper("node:sqlite")',
        "export const c = (x: never, k: string) => {",
        "  const t = typeof x",
        "  const t2 = t",
        '  if (t2 === "string" || 1 < 2) return 1',
        "  return 0",
        "}",
        'type AB = "a" | "b"',
        "export const d = (arr: ReadonlyArray<{ kind: AB }>, u: AB, u2: AB, v: { _tag: 'X' } | { _tag: 'Y' }, v2: { _tag: 'X' } | { _tag: 'Y' }, k: number) => {",
        "  const va = v._tag",
        "  let n = 0",
        "  if (v._tag === 'X' && v2._tag === 'Y') n += 1",
        "  if (va === 'X' || va === 'Y') n += 1",
        "  if (u === 'a' && u2 === 'b') n += 1",
        "  if (k < 1 && v._tag === 'X') n += 1",
        "  if (k === 1 && v._tag === 'X') n += 1",
        '  const flt = arr.filter((i) => i.kind === "a")',
        '  const fnd = arr.find((i) => i.kind === "a")',
        '  const sme = arr.some((i) => i.kind === "a")',
        '  const evr = arr.every((i) => i.kind === "a")',
        "  const res = match(u).with('a', () => 1).otherwise(() => 0)",
        "  const okMat = match(u).with('a', () => 1).with('b', () => 2).exhaustive()",
        "  const non = { otherwise: () => 1 }.otherwise()",
        "  return [n, flt, fnd, sme, evr, res, okMat, non, okCall, a, b]",
        "}",
        "export const evoReducer = () => Effect.runSync(Effect.succeed(1))",
        "export const dec = Decider.make({ decide: () => Effect.runSync(Effect.succeed(1)) })",
      ].join("\n"),
    )
    const v1: Array<BranchingViolation> = []
    checkPass0ZeroToleranceAst(
      sf1,
      { filePath: "libs/demo/infra/src/a.ts", content: sf1.getFullText(), packageTag: "infra" },
      v1,
    )
    expect(v1.map((x) => x.line)).toEqual([5])
    const vSql: Array<BranchingViolation> = []
    checkNodeSqliteInInfra(sf1, "libs/demo/infra/src/a.ts", "infra", vSql)
    expect(vSql.map((x) => x.line)).toEqual([1, 2, 3])
    const vBr: Array<BranchingViolation> = []
    checkDiscriminantAndPredicateBranching(sf1, "libs/demo/infra/src/a.ts", vBr)
    expect(vBr.map((x) => x.line)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23])
    const vRun: Array<BranchingViolation> = []
    checkUnscopedEffectRun(sf1, "libs/demo/infra/src/a.ts", "infra", vRun)
    expect(vRun).toHaveLength(2)
    const vMat: Array<BranchingViolation> = []
    checkNonExhaustiveUnionMatch(sf1, "libs/demo/infra/src/a.ts", vMat)
    expect(vMat.map((x) => x.line)).toEqual([24])

    const sf2 = makeSf(
      "libs/demo/domain/src/ok.ts",
      "export const r = Effect.runSync(Effect.succeed(1))",
    )
    const vDom: Array<BranchingViolation> = []
    checkUnscopedEffectRun(sf2, "libs/demo/domain/src/ok.ts", "domain", vDom)
    expect(vDom).toHaveLength(1)
    const sf3 = makeSf(
      "libs/demo/contract/src/testing.ts",
      "export const r = Effect.runSync(Effect.succeed(1))",
    )
    const vTest: Array<BranchingViolation> = []
    checkUnscopedEffectRun(sf3, "libs/demo/contract/src/testing.ts", "contract", vTest)
    expect(vTest).toHaveLength(0)
    const sf4 = makeSf(
      "libs/demo/contract/src/real.ts",
      "export const r = Effect.runSync(Effect.succeed(1))",
    )
    const vContractRun: Array<BranchingViolation> = []
    checkUnscopedEffectRun(sf4, "libs/demo/contract/src/real.ts", "contract", vContractRun)
    expect(vContractRun).toHaveLength(1)
  })

  it("brand-boundary-extractor covers primitive/branded casts, contract aliases/brands, TaggedError _tag, services, and domain fns", () => {
    const sfContract = makeSf(
      "libs/demo/contract/src/c.ts",
      [
        "export type BadAlias = string",
        "export const UserId = Schema.String.pipe(Schema.brand('UserId'))",
        "export type UserId = typeof UserId.Type",
        "export const OtherId = Schema.String.pipe(Schema.brand('UserId'))",
        "export const ViaS = S.String.pipe(S.brand('SKey'))",
        "export const DupS = S.String.pipe(S.brand('SKey'))",
        "export const RawStr = Schema.String",
        "export const PlainConst = 123",
        "export class ErrOne extends Schema.TaggedError<ErrOne>()('ErrOne', {",
        "  _tag: Schema.Literal('ErrOne'),",
        "  goodField: Schema.String.pipe(Schema.brand('GoodKey')),",
        "  badField: Schema.String,",
        "}) {}",
      ].join("\n"),
    )
    const vC: Array<BranchingViolation> = []
    checkBrandedDomainTypesAndPrimitiveBoundaries(
      sfContract,
      "libs/demo/contract/src/c.ts",
      "contract",
      vC,
    )
    expect(vC.map((v) => v.line)).toEqual([1, 4, 6, 7, 12])

    const sfDomain = makeSf(
      "libs/demo/domain/src/d.ts",
      [
        "type Bid = Branded<string, 'Bid'>",
        "export const okFn = Effect.fn('D.okFn')((x: Bid): Bid => x)",
        "export const badTraced = Effect.fn('D.badTraced')((x: string): string => x)",
        "export const untracedBad = Effect.fnUntraced((x: string): { n: number } => ({ n: 1 }))",
        "export const badPrimRet = (x: Bid): string => String(x)",
        "export const badObjRet = (x: Bid) => ({ count: 1 as number })",
      ].join("\n"),
    )
    const vD: Array<BranchingViolation> = []
    checkBrandedDomainTypesAndPrimitiveBoundaries(
      sfDomain,
      "libs/demo/domain/src/d.ts",
      "domain",
      vD,
    )
    expect(vD.map((v) => v.line)).toEqual([3, 3, 4, 4, 4, 5, 6])

    const sfCleanDomain = makeSf(
      "libs/demo/domain/src/clean.ts",
      [
        "type Bid = Branded<string, 'Bid'>",
        "export const okFn = Effect.fn('D.okFn')((x: Bid): Bid => x)",
      ].join("\n"),
    )
    const vClean: Array<BranchingViolation> = []
    checkBrandedDomainTypesAndPrimitiveBoundaries(
      sfCleanDomain,
      "libs/demo/domain/src/clean.ts",
      "domain",
      vClean,
    )
    expect(vClean).toEqual([])
  })

  it("decider-reducer-extractor covers resolveSchemasForParameter, checkDeciderTracing, decider.ts make forms, and aggregate id guards", () => {
    const sfDec = makeSf(
      "libs/demo/domain/src/decider.ts",
      [
        "export const make = (options: unknown) => options",
        "export function make2(options: unknown) { return options }",
        "export const notMake = (options: unknown) => options",
        "export const okObj = { make(options: unknown) { return { decide: Effect.fn('X')(options) } } }",
        "export const okObj2 = { make: (options: unknown) => ({ ...options }) }",
        "export const badObj = { make: (options: unknown) => {return options} }",
        "export const badObj2 = { make(options: unknown) {return options;} }",
        "export const badNotProp = { notMake: (options: unknown) => options }",
        "export const badNotMeth = { notMake(options: unknown) { return options } }",
        "export const d1 = Decider.make({ decide: (s: unknown) => s })",
        "export const dCall = Decider.make({ decide: someWrapper((s: unknown) => s) })",
        "export const dCurried = Decider.make({ decide: curriedWrapper()((s: unknown) => s) })",
        "export const d2 = PkgDecider.make({ decide: Effect.fn('D.dec')((s: unknown) => s) })",
        "export const d3 = PkgDecider.make({ decide: Effect.fn((s: unknown) => s) })",
        "export const aliasDec = Effect.fn('D.decide')(function* (cmd: AliasCmd, state: AliasState) { return state })",
        "declare type AliasCmd = { readonly kind: 'Go' }",
        "declare type AliasState = { readonly phase: 'Init' }",
        "export const helperFn = (p: typeof AliasCmd.Type & Readonly<Schema.Type<typeof AliasCmd>>) => p",
      ].join("\n"),
    )
    const vDec: Array<BranchingViolation> = []
    checkDeciderTracing(sfDec, "libs/demo/domain/src/decider.ts", "domain", vDec)
    expect(vDec.map((v) => v.line)).toEqual([10, 11, 12, 1, 6, 7])

    const fakeInfo = (tag: string, props: ReadonlyArray<string>): TaggedSchemaInfo => ({
      tag,
      properties: [...props],
      file: "c.ts",
      line: 1,
    })
    const byTag = new Map<string, TaggedSchemaInfo>([
      ["AliasCmd", fakeInfo("AliasCmd", ["commandId", "id", "tenantId"])],
      ["AliasState", fakeInfo("AliasState", ["id", "tenantId"])],
      ["CmdReserved", fakeInfo("CmdReserved", ["commandId", "id"])],
      ["StReserved", fakeInfo("StReserved", ["commandId", "id"])],
      ["UnresCmd", fakeInfo("UnresCmd", ["commandId", "id", "tenantId"])],
      ["UnresState", fakeInfo("UnresState", ["commandId", "id", "tenantId"])],
      ["CmdA", fakeInfo("CmdA", ["commandId"])],
      ["CmdB", fakeInfo("CmdB", ["commandId", "tenantId"])],
      ["typeof", fakeInfo("typeof", ["bogus"])],
      ["Type", fakeInfo("Type", ["bogus"])],
      ["Schema", fakeInfo("Schema", ["bogus"])],
      ["Readonly", fakeInfo("Readonly", ["bogus"])],
    ])
    const helperParam = sfDec
      .getVariableDeclarationOrThrow("helperFn")
      .getInitializerIfKindOrThrow(ts.SyntaxKind.ArrowFunction)
    expect(
      resolveSchemasForParameter(helperParam.getParameters()[0]!, byTag, byTag, new Map()),
    ).toEqual([byTag.get("AliasCmd")])

    const sfGuards = makeSf(
      "libs/demo/domain/src/guards.ts",
      [
        "export const okStrict = Effect.fn('A.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const ok = (c.orderId) === s.orderId; return ok ? s : s })",
        "export const okNeq = Effect.fn('B.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const ok = (c.orderId) !== s.orderId; return ok ? s : s })",
        "export const okLooseEq = Effect.fn('C.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const ok = (c.orderId) == s.orderId; return ok ? s : s })",
        "export const okLooseNeq = Effect.fn('D.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const ok = (c.orderId) != s.orderId; return ok ? s : s })",
        "export const okEqCall = Effect.fn('E.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const ok = Equal.equals((c.orderId), s.orderId); return ok ? s : s })",
        "export const okPkgEq = Effect.fn('F.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const ok = Pkg.Equal.equals((c.orderId), s.orderId); return ok ? s : s })",
        "export const okCmdIdOnly = Effect.fn('G.decide')(function* (c: { readonly commandId: string; readonly id: string }, s: { readonly commandId: string; readonly id: string }) { return s })",
        "export const okUnresReserved = Effect.fn('L.decide')(function* (c: CmdReserved, s: StReserved) { return s })",
        "export const okGuardTenant = Effect.fn('N.decide')(function* (c: UnresCmd, s: UnresState) { return c.tenantId === s.tenantId ? s : s })",
        "export const badUnres = Effect.fn('M.decide')(function* (c: UnresCmd, s: UnresState) { return s })",
        "export const badUnresUnion = Effect.fn('O.decide')(function* (c: CmdA | CmdB, s: UnresState) { return s })",
        "export const badLt = Effect.fn('H.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const bad = c.orderId < s.orderId; return bad ? s : s })",
        "export const badSelf = Effect.fn('I.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { if (c.orderId === c.orderId) return s; return s })",
        "export const badOneArgEq = Effect.fn('J.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const b = Equal.equals(c.orderId as never); return b ? s : s })",
        "export const badOtherCall = Effect.fn('K.decide')(function* (c: { readonly orderId: string }, s: { readonly orderId: string }) { const b = Equal.nope(c.orderId, s.orderId); return b ? s : s })",
      ].join("\n"),
    )
    const vId: Array<BranchingViolation> = []
    checkMissingAggregateIdGuard(
      sfGuards,
      "libs/demo/domain/src/guards.ts",
      "domain",
      byTag,
      byTag,
      new Map(),
      vId,
    )
    expect(vId.map((x) => x.enclosingSymbol)).toEqual([
      "libs/demo/domain/src/guards.ts#badUnres",
      "libs/demo/domain/src/guards.ts#badUnresUnion",
      "libs/demo/domain/src/guards.ts#badLt",
      "libs/demo/domain/src/guards.ts#badSelf",
      "libs/demo/domain/src/guards.ts#badOneArgEq",
      "libs/demo/domain/src/guards.ts#badOtherCall",
    ])
  })

  it("reducer-policy-extractor covers terminal state handling, string _tag fallback, and dead event payload", () => {
    const sfRed = makeSf(
      "libs/demo/domain/src/red.ts",
      [
        "type St = { readonly _tag: 'Active'; readonly n: number } | { readonly _tag: 'Completed' }",
        "type OpaqueSt = { readonly phase: string }",
        "type TaggedOnlyEv = { readonly _tag: 'TaggedEv'; readonly extra: string }",
        "type Ev = { readonly _tag: 'Added'; readonly amount: number; readonly version: number; readonly extra: string } | { readonly _tag: 'Stopped' }",
        "type FallbackEv = { readonly _tag: string }",
        "interface WrappedInlineSt { readonly _tag: 'InlineActive' }",
        "type BrandAliasEv = { readonly _tag: 'InlineAdded'; readonly itemId: string; readonly unused: string } | { readonly _tag: string & { readonly __b: 'BrandAdded' } } | { readonly _tag: 'BodyOnlyEv' }",
        "type HideParam<T> = { readonly _tag: 'InlineAdded' } | { readonly other: string }",
        "export const evolveItem = (state: St, ev: Ev, e: Ev, event: Ev) => {",
        "  return match(state).with({ _tag: 'Completed' }, (doneSt) => doneSt).otherwise(() =>",
        "    match(e).with({ _tag: 'Added' }, ({ amount }) =>",
        "      match(event).with({ _tag: 'Added' }, () => match(ev).with({ _tag: 'Added' }, () => ({ _tag: 'Completed' as const })).otherwise(() => ({ _tag: 'Completed' as const }))).otherwise(() => ({ _tag: 'Completed' as const }))",
        "    ).with({ _tag: 'Stopped' }, () => ({ _tag: 'Completed' as const })).exhaustive()",
        "  )",
        "}",
        "export const evolveBad = (state: OpaqueSt, ev: Ev) => {",
        "  const nonMatch = { with: (x: unknown) => x }.with({ _tag: 'Added' }, () => state)",
        "  const x = match(ev).with({ _tag: 'Added' }, ({ amount }) => ({ extra: 1 })).with({ _tag: 'Stopped' }, () => state).exhaustive()",
        "  return [nonMatch, x]",
        "}",
        "export const evolveGenericTag = (state: { readonly _tag: string }, e: FallbackEv) =>",
        "  match(e).with({ _tag: 'Added' }, { _tag: 'TaggedEv' }, (x) => ({ ...state, v: x.amount, alt: ({ a: 1 }).a })).with({ _tag: 'OtherPat' }, () => state).with({ notTag: 1 }, () => state).exhaustive()",
        "export const evolveBadAction = (state: St, action: Ev) => [",
        "  match(action).with({ _tag: 'Added' }, ({ amount, extra }) => ({ n: amount + extra.length })).with({ _tag: 'Stopped' }, () => state).exhaustive(),",
        "  match(Boolean(action)).with(true, () => state).with(false, () => state).exhaustive(),",
        "]",
        "export const evolveBadEventLit = (state: St, cmd: Ev, event: Ev) =>",
        "  match(event).with({ _tag: 'Added' }, ({ amount, extra }) => ({ n: amount + extra.length })).with({ _tag: 'Stopped' }, () => state).exhaustive()",
        "export const evolveBadEvLit = (state: St, cmd: Ev, ev: Ev) =>",
        "  match(ev).with({ _tag: 'Added' }, ({ amount, extra }) => ({ n: amount + extra.length })).with({ _tag: 'Stopped' }, () => state).exhaustive()",
        "export const evolveInlineVariants = (state: WrappedInlineSt, cmd: BrandAliasEv) =>",
        "  match(cmd).with({ _tag: 'InlineAdded' }, () => ({ _tag: 'BodyOnlyEv' })).with({ _tag: 'BrandAdded' }, () => state).with({ _tag: 'NonEvSchema' }, () => state).exhaustive()",
        "export const evolveInlineNodeOnly = (state: WrappedInlineSt, cmd: HideParam<'NodeAdded'>) =>",
        "  match(cmd).with({ _tag: 'NodeAdded' }, () => state).exhaustive()",
      ].join("\n"),
    )
    const byTag = new Map<string, TaggedSchemaInfo>([
      [
        "Added",
        { tag: "Added", properties: ["_tag", "version", "amount", "extra"], file: "c.ts", line: 1 },
      ],
      ["TaggedEv", { tag: "TaggedEv", properties: ["extra"], file: "c.ts", line: 2 }],
      ["Stopped", { tag: "Stopped", properties: [], file: "c.ts", line: 3 }],
      ["Completed", { tag: "Completed", properties: ["secretProp"], file: "c.ts", line: 4 }],
      [
        "InlineActive",
        { tag: "InlineActive", properties: ["_tag", "itemId"], file: "c.ts", line: 5 },
      ],
      [
        "InlineAdded",
        { tag: "InlineAdded", properties: ["_tag", "itemId", "unused"], file: "c.ts", line: 6 },
      ],
      ["BrandAdded", { tag: "BrandAdded", properties: ["_tag", "unusedB"], file: "c.ts", line: 7 }],
      ["NodeAdded", { tag: "NodeAdded", properties: ["_tag", "unusedN"], file: "c.ts", line: 8 }],
      ["BodyOnlyEv", { tag: "BodyOnlyEv", properties: ["_tag", "unusedH"], file: "c.ts", line: 9 }],
      [
        "NonEvSchema",
        { tag: "NonEvSchema", properties: ["_tag", "unusedNon"], file: "c.ts", line: 10 },
      ],
    ])
    const byName = new Map<string, TaggedSchemaInfo>([["OpaqueSt", byTag.get("Completed")!]])
    const v: Array<BranchingViolation> = []
    checkEventSourcingReducers(
      sfRed,
      "libs/demo/domain/src/red.ts",
      "domain",
      byTag,
      byName,
      new Map(),
      v,
    )
    expect(v.filter((x) => x.rule === "terminal-state-unhandled").map((x) => x.line)).toEqual([
      18, 24, 28, 30,
    ])
    expect(
      v
        .filter((x) => x.rule === "dead-event-payload")
        .map((x) => `${x.enclosingSymbol}:${x.message.match(/property '(\w+)'/)?.[1]}`),
    ).toEqual([
      "libs/demo/domain/src/red.ts#evolveItem:extra",
      "libs/demo/domain/src/red.ts#evolveBad:extra",
      "libs/demo/domain/src/red.ts#evolveGenericTag:extra",
      "libs/demo/domain/src/red.ts#evolveGenericTag:extra",
      "libs/demo/domain/src/red.ts#evolveInlineVariants:unused",
      "libs/demo/domain/src/red.ts#evolveInlineNodeOnly:unusedN",
    ])
  })

  it("schema-and-brand-extractor covers S/Custom Struct, TaggedStruct, TaggedClass, optionalWith, and handwritten unions", () => {
    const sfSch = makeSf(
      "libs/demo/contract/src/s.ts",
      [
        "export class ItemClass extends Schema.TaggedClass<ItemClass>()('ItemTag', {",
        "  _tag: Schema.Literal('ItemTag'),",
        "  streamVersion: Schema.Int,",
        "  created: S.optionalWith(S.Boolean, { default: () => false }),",
        "}) {}",
        "export class OneArgClass extends Schema.TaggedClass<OneArgClass>()('OnlyTag') {}",
        "export const St1 = Schema.Struct({ completed: Schema.optional(Schema.Boolean) })",
        "export const St2 = S.Struct({ archived: S.optional(S.Boolean), active: Schema.optionalWith(Schema.Boolean) })",
        "export const Ts = Schema.TaggedStruct('TsTag', { deleted: Schema.Boolean })",
        "export const CTs = S.TaggedStruct('CtsTag', { quantity: Schema.Int })",
        "export const EmptyStruct = S.Struct()",
        "export type SelfRef = SelfRef",
        "export type BadUnion = { _tag: 'A'; x: number } | { _tag: 'B' } | { nope: string }",
        "export type OneTagUnion = { _tag: 'A' } | { nope: string }",
        "export const CleanOther = Custom.NotStruct({ flag: Schema.Boolean })",
        "export type PlainPair = { readonly a: string } | { readonly b: number }",
      ].join("\n"),
    )
    const schemas: Array<SchemaDefNode> = []
    const byTag = new Map<string, TaggedSchemaInfo>()
    const byName = new Map<string, TaggedSchemaInfo>()
    const unionTags = new Map<string, ReadonlyArray<string>>()
    extractSchemaDefinitions(
      sfSch,
      "libs/demo/contract/src/s.ts",
      "contract",
      schemas,
      byTag,
      byName,
      unionTags,
    )
    expect(byTag.get("ItemTag")?.properties).toEqual(["streamVersion", "created"])
    expect(unionTags.has("SelfRef")).toBe(false)
    expect(byTag.has("TsTag")).toBe(true)

    const vS: Array<BranchingViolation> = []
    checkSchemaBooleanStateAndBrandedFields(sfSch, "libs/demo/contract/src/s.ts", "contract", vS)
    expect(vS.map((x) => `${x.rule}@${x.line}`)).toEqual([
      "unbranded-schema-field@3",
      "schema-boolean-state@4",
      "schema-boolean-state@7",
      "schema-boolean-state@8",
      "schema-boolean-state@8",
      "schema-boolean-state@9",
      "unbranded-schema-field@10",
      "handwritten-tagged-union@13",
    ])
  })

  it("effect-fn-extractor covers fnUntraced vs other calls and ErrorTag.make", () => {
    const sfEff = makeSf(
      "libs/demo/domain/src/eff.ts",
      [
        "export const myLayer = Layer.succeed('S', {})",
        "export const untracedUseCase = Effect.fnUntraced(function* () {",
        "  return yield* MyDeclaredFault.make({})",
        "})",
        "export const plainWrapper = someWrapper(() => 1)",
      ].join("\n"),
    )
    const fns: Array<EffectFnNode> = []
    const failsWith: Array<{ readonly callerQualname: string; readonly errorTag: string }> = []
    const requiresService: Array<{ readonly callerQualname: string; readonly tagId: string }> = []
    const refErrs = new Set<string>()
    extractEffectFns(
      sfEff,
      "libs/demo/domain/src/eff.ts",
      "domain",
      fns,
      failsWith,
      requiresService,
      new Map(),
      new Map(),
      refErrs,
      new Set(),
      [],
      [
        {
          _tag: "TaggedError",
          errorTag: "MyDeclaredFault",
          file: "e.ts",
          line: 1,
          qualname: "e.ts#MyDeclaredFault",
        },
      ],
    )
    expect(fns.map((f) => f.spanName)).toEqual(["untracedUseCase"])
    expect(failsWith.map((e) => e.errorTag)).toContain("MyDeclaredFault")
  })

  it("extractor-types-and-helpers and governance-markdown-helpers cover remaining predicates and table escapes", () => {
    const sfTypes = makeSf(
      "libs/demo/core/src/t.ts",
      [
        "type BrandedU = Branded<'a', 'K'> | Branded<'b', 'K'>",
        "type SingleNullable = Branded<'a', 'K'> | undefined",
        "type PlainStr = string",
        "type OpenU = string | Branded<'a', 'K'>",
        "export const t = (a: BrandedU, b: SingleNullable, c: OpenU) => a === 'a' || a !== 'b' || (a == 'a' || a != 'b' || true || false)",
      ].join("\n"),
    )
    const getVarType = (n: string) => sfTypes.getTypeAliasOrThrow(n).getType()
    expect(isClosedStringLiteralUnionType(getVarType("BrandedU"))).toBe(true)
    expect(isClosedStringLiteralUnionType(getVarType("SingleNullable"))).toBe(false)
    expect(isClosedStringLiteralUnionType(getVarType("PlainStr"))).toBe(false)
    expect(isClosedStringLiteralUnionType(getVarType("OpenU"))).toBe(false)

    expect(isEqualityOpKind(ts.SyntaxKind.EqualsEqualsEqualsToken)).toBe(true)
    expect(isEqualityOpKind(ts.SyntaxKind.ExclamationEqualsEqualsToken)).toBe(true)
    expect(isEqualityOpKind(ts.SyntaxKind.EqualsEqualsToken)).toBe(true)
    expect(isEqualityOpKind(ts.SyntaxKind.ExclamationEqualsToken)).toBe(true)
    expect(isEqualityOpKind(ts.SyntaxKind.PlusToken)).toBe(false)

    const falseKw = sfTypes.getDescendantsOfKind(ts.SyntaxKind.FalseKeyword)[0]!
    expect(isLiteralNode(falseKw)).toBe(true)
    const prevTrue = sfTypes.getDescendantsOfKind(ts.SyntaxKind.TrueKeyword)[0]!
    expect(isLiteralNode(prevTrue)).toBe(true)
    const ident = sfTypes.getDescendantsOfKind(ts.SyntaxKind.Identifier)[0]!
    expect(isLiteralNode(ident)).toBe(false)

    expect(
      splitMarkdownTableCells("| ``code | span`` | a \\| b | `\\|` | `\\\\` | \\`raw\\\\ | \\|"),
    ).toEqual(["``code | span``", "a | b", "`|`", "`\\\\`", "`raw\\", "|"])
    expect(splitMarkdownTableCells("|\\\\|")).toEqual(["\\"])
  })
})
