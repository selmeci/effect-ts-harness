import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
} from "@harness/contract"
import { buildHarnessGraph, ts } from "@harness/graph"
import {
  WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS,
  decideEarsSpecQuality,
  decideEffectLawsGate,
  decideGraphEntropy,
  decideSelfDogfooding,
  decideSyntaxBansGate,
  decideTestIntegrityGate,
  explainCommandDenyReason,
} from "../src/index.js"
import { CANONICAL_CLOSED_LITERAL_TYPES } from "../src/plugins/ast-wave3-laws.js"
import {
  WORKER_ISOLATION_PARITY_DOC_PATHS,
  auditWorkerIsolationSubcommandParity,
} from "../src/plugins/gc/gc-catalog-doc-truth.js"
import { checkAlwaysPopulatedOptionalRuntimeProps } from "../src/plugins/gc/gc-topology-entropy.plugin.js"
import { testHostIo } from "./helpers/test-host-io.js"

const REPO_ROOT = resolve(import.meta.dirname, "../../../..")

const evalEffectLaws = (filePath: string, content: string) =>
  Effect.runSync(
    decideEffectLawsGate({
      ruleVersion: DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
      files: [
        { filePath: AstSourceFilePath.make(filePath), content: AstSourceContent.make(content) },
      ],
    }),
  )

const evalSyntaxBans = (filePath: string, content: string) =>
  Effect.runSync(
    decideSyntaxBansGate({
      ruleVersion: DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
      files: [
        { filePath: AstSourceFilePath.make(filePath), content: AstSourceContent.make(content) },
      ],
    }),
  )

const evalTestIntegrity = (filePath: string, content: string) =>
  Effect.runSync(
    decideTestIntegrityGate({
      ruleVersion: DEFAULT_IN_MEMORY_GATE_RULE_VERSION,
      files: [
        {
          filePath: AstSourceFilePath.make(filePath),
          content: AstSourceContent.make(content),
          packageTag: AstGatePackageTag.make("test"),
        },
      ],
    }),
  )

const evalSelfDogfood = (filePath: string, content: string) =>
  Effect.runSync(
    decideSelfDogfooding({
      files: [
        { filePath: AstSourceFilePath.make(filePath), content: AstSourceContent.make(content) },
      ],
    }),
  )

const createParityFixture = (
  subcmdsInDoc: string,
  options?: { readonly interpolatePolicy?: boolean; readonly dropLastDoc?: boolean },
): string => {
  const interpolatePolicy = options?.interpolatePolicy ?? true
  const dropLastDoc = options?.dropLastDoc ?? false
  const tmp = mkdtempSync(join(tmpdir(), "w3-doc-parity-"))
  const policyPath = join(tmp, "libs/harness/gates/src/policy.ts")
  mkdirSync(join(tmp, "libs/harness/gates/src"), { recursive: true })
  writeFileSync(
    policyPath,
    interpolatePolicy
      ? 'export const r = `${WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join(", ")}`'
      : 'export const r = "hardcoded"',
  )
  const docs = dropLastDoc
    ? WORKER_ISOLATION_PARITY_DOC_PATHS.slice(0, -1)
    : WORKER_ISOLATION_PARITY_DOC_PATHS
  for (const rel of docs) {
    const abs = join(tmp, rel)
    mkdirSync(resolve(abs, ".."), { recursive: true })
    writeFileSync(
      abs,
      `When \`HARNESS_UNIT_WORKER=1\`, \`harness workflow ${subcmdsInDoc}\` is blocked.`,
    )
  }
  return tmp
}

describe("SPEC-0033 Wave 3 Preventive Gates", () => {
  it("REQ-3.1: EffectLaws.decide bans ignore, silent catch*/orElse*/asVoid, and statement-body silent blocks", () => {
    const bad = evalEffectLaws(
      "libs/demo/core/src/swallow-operators.ts",
      `import { Effect } from "effect"
export const b1 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.ignore)
export const b2 = (eff: Effect.Effect<void, Error>) => Effect.ignoreCause(eff)
export const b3 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.orElseSucceed(() => undefined))
export const b4 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catch(() => Effect.void))
export const b5 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchAll(() => Effect.succeed(null)))
export const b6 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchTag("E", () => Effect.void))
export const b7 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchTags({ E: () => Effect.void }))
export const b8 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchIf(() => true, () => Effect.void))
export const b9 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchCause(() => Effect.void))
export const b10 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchAllCause(() => Effect.void))
export const b11 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.orElse(() => Effect.void))
export const b12 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchAll(() => Effect.asVoid(Effect.succeed(1))))
export const b13 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.orElseSucceed(() => { const _ = 0; return undefined }))
export const b14 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchAll(() => { return }))
export const b15 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchAll(() => { const v = Effect.void; return v }))`,
    )
    expect(bad.violations.filter((v) => v.rule === "silent-error-swallow").length).toBe(15)
  })

  it("REQ-3.1: EffectLaws.decide catches finalizer args, Effect aliases, multi-stage pipes, unsafe Effect.sync, and console.*", () => {
    const fin = evalEffectLaws(
      "libs/demo/infra/src/finalizers-and-aliases.ts",
      `import { Effect as E, Scope } from "effect"
import { ignore as ig } from "effect/Effect"
import * as Ef from "effect"
export const r1 = (eff: E.Effect<void>) => eff.pipe(E.onExit(() => ig(E.void)))
export const r2 = (eff: E.Effect<void>) => eff.pipe(E.ensuring(Ef.Effect["ignore"](E.void)))
export const r3 = (eff: E.Effect<void>) => eff.pipe(E.onInterrupt(() => { const { ignoreCause } = E; return E.void.pipe(ignoreCause) }))
export const r4 = () => E.addFinalizer(() => E.ignore(E.void))
export const r5 = (s: Scope.Scope) => Scope.addFinalizer(s, E.ignore(E.void))
export const r6 = (eff: E.Effect<void>) => withCompensation(eff, E.ignore(E.void))
export const r7 = () => E.acquireRelease(E.void, () => E.ignore(E.void))
export const r8 = () => E.acquireUseRelease(E.void, () => E.void, () => E.ignore(E.void))
export const r9 = (eff: E.Effect<void>, doDangerous: () => void) => eff.pipe(E.onExit(() => E.logInfo("x").pipe(E.tap(() => doDangerous()), E.ignore)))
export const r10 = (eff: E.Effect<void>, fnRef: () => void) => eff.pipe(E.onExit(() => E.sync(fnRef).pipe(E.ignore)))
export const r11 = (eff: E.Effect<void>) => eff.pipe(E.onExit(() => E.sync(() => console.warn("x")).pipe(E.ignore)))`,
    )
    expect(fin.violations.filter((v) => v.rule === "silent-error-swallow").length).toBe(11)
  })

  it("REQ-3.1: EffectLaws.decide allows pure Effect.log*/telemetry/stderr swallows, typed fallbacks, and non-core non-finalizer code", () => {
    const allowed = evalEffectLaws(
      "libs/demo/core/src/core-ok.ts",
      `import { Effect, Option } from "effect"
export const ok1 = (eff: Effect.Effect<Option.Option<string>, Error>) => eff.pipe(Effect.orElseSucceed(() => Option.none()))
export const ok2 = (eff: Effect.Effect<number, Error>) => eff.pipe(Effect.orElseSucceed(() => 0))
export const ok3 = () => Effect.logWarning("warn").pipe(Effect.ignore)
export const ok4 = () => Effect.try(() => process.stderr.write("x")).pipe(Effect.ignore)
export const ok5 = () => Effect.logInfo("x").pipe(Effect.tap(() => recordTelemetry("evt")), Effect.ignore)
export const ok6 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catch((e) => Effect.logError(String(e))))
export const ok7 = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchCause((c) => Effect.failCause(c)))`,
    )
    expect(allowed.violations.filter((v) => v.rule === "silent-error-swallow")).toEqual([])

    const infraAllowed = evalEffectLaws(
      "libs/demo/infra/src/non-finalizer-ok.ts",
      `import { Effect } from "effect"
export const ok = (eff: Effect.Effect<void, Error>) => Effect.acquireRelease(eff.pipe(Effect.ignore), () => Effect.logInfo("rel"))`,
    )
    expect(infraAllowed.violations.filter((v) => v.rule === "silent-error-swallow")).toEqual([])

    const pass2Bad = evalEffectLaws(
      "libs/demo/core/src/pass2-swallows.ts",
      `import { Effect } from "effect"
export const badMut = (state: { dirty: boolean }) => Effect.sync(() => { state.dirty = true; Effect.logDebug("x") }).pipe(Effect.ignore)
export const badLocalLog = (log: (s: string) => void) => Effect.sync(() => log("x")).pipe(Effect.ignore)
export const badMethodTelemetry = (tx: { recordTelemetry: (s: string) => void }) => Effect.sync(() => tx.recordTelemetry("x")).pipe(Effect.ignore)
export const badMixedCatch = (eff: Effect.Effect<void, Error>) => eff.pipe(Effect.catchAll((e) => { if (e) Effect.logError(String(e)); return Effect.void }))
export const badTernaryCatch = (eff: Effect.Effect<void, Error>, flag: boolean) => eff.pipe(Effect.catch(() => (flag ? Effect.logWarning("w") : Effect.void)))`,
    )
    expect(pass2Bad.violations.filter((v) => v.rule === "silent-error-swallow").length).toBe(5)
  })

  it("REQ-3.2: SyntaxBans.decide checks closed unions, scoping, destructuring, fn returns, forward/var/Readonly, and avoids .status FPs", () => {
    const bad = evalSyntaxBans(
      "libs/demo/domain/src/closed-cmp.ts",
      `import { Schema } from "effect"
import type { ReviewDepth, ShipAttemptStatus } from "@harness/contract"
const LocalMode = Schema.Literals(["fast", "full"])
const SingleVariant = Schema.Literals(["only"])
type LocalPhase = "plan" | "impl"
interface AttemptRow { readonly status: ShipAttemptStatus }
interface HttpResponse { readonly status: string }
export const fn = (
  a: typeof LocalMode.Type,
  single: typeof SingleVariant.Type,
  row: AttemptRow,
  http: HttpResponse,
  open: string,
  ro: Readonly<{ mode: LocalPhase }>,
  depth: ReviewDepth = "lite",
) => {
  if (a === "fast") return 1
  if (single === "only") return 1
  if (row.status === "running") return 2
  if (http.status === "ok") return 3
  const { status: st } = row
  if (st === "passed") return 4
  const ph = getPhase()
  if (ph === "impl") return 5
  if (ro.mode === "plan") return 6
  if (depth === "lite") return 7
  if (hoisted === "x") return 8
  if (true) { var hoisted: "x" | "y" = "x" }
  const x = row.status === "failed" ? 1 : 0
  for (const a of ["fast"]) { if (a === "fast") return x }
  if (typeof open === "string" && open === "hello") return 9
  return 0
}
function getPhase(): LocalPhase { return "plan" }
export const fnOpen = (mode: string) => (mode === "a" ? 1 : 0)`,
    )
    const rules = bad.violations.filter((v) => v.rule === "discriminant-branching")
    expect(rules.length).toBe(8)
  })

  it("REQ-3.2: CANONICAL_CLOSED_LITERAL_TYPES has 100% parity with WAVE3_CANONICAL_CLOSED_LITERAL_TYPES in syntax-bans.js", () => {
    const src = readFileSync(join(REPO_ROOT, "tools/oxlint/syntax-bans.js"), "utf8")
    const sf = ts.createSourceFile("syntax-bans.js", src, ts.ScriptTarget.Latest, true)
    const jsTypes = new Set<string>()
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "WAVE3_CANONICAL_CLOSED_LITERAL_TYPES"
      ) {
        const collectStrs = (inner: ts.Node): void => {
          if (ts.isStringLiteral(inner) && inner.text.trim().length > 0) {
            for (const tok of inner.text.trim().split(/\s+/)) jsTypes.add(tok)
          }
          ts.forEachChild(inner, collectStrs)
        }
        if (n.initializer !== undefined) collectStrs(n.initializer)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(CANONICAL_CLOSED_LITERAL_TYPES.size).toBe(102)
    expect(Array.from(jsTypes).sort()).toEqual(Array.from(CANONICAL_CLOSED_LITERAL_TYPES).sort())
  })

  it("REQ-3.3: flags direct/aliased/out-of-order daemon Workflow.interrupt and unguarded workflow status mutations", () => {
    const badInterrupt = evalSelfDogfood(
      "apps/harness-mcp/src/daemon/bad-helper.ts",
      `export const abort1 = (id: string) => ShipWorkflow.interrupt(id)
export const abort2 = (runtime: { readonly shipWorkflow: typeof ShipWorkflow }, id: string) => runtime.shipWorkflow.interrupt(id)
export const abort3 = (id: string) => ShipWorkflow["interrupt"](id)
export const interruptAndSettleBad = (id: string) => {
  waitForWorkflowCompletion(id)
  return ShipWorkflow.interrupt(id)
}`,
    )
    expect(
      badInterrupt.violations.filter((v) => v.rule === "direct-daemon-workflow-interrupt").length,
    ).toBe(4)

    const goodInterrupt = evalSelfDogfood(
      "apps/harness-mcp/src/daemon/good-helper.ts",
      `export const interruptAndSettleShip = (id: string) => {
  ShipWorkflow.interrupt(id)
  return waitForWorkflowCompletion(id)
}`,
    )
    expect(
      goodInterrupt.violations.filter((v) => v.rule === "direct-daemon-workflow-interrupt"),
    ).toEqual([])

    const nonDaemon = evalSelfDogfood(
      "apps/harness-cli/src/helper.ts",
      `export const abortIt = (id: string) => ShipWorkflow.interrupt(id)`,
    )
    expect(
      nonDaemon.violations.filter((v) => v.rule === "direct-daemon-workflow-interrupt"),
    ).toEqual([])
  })

  it("REQ-3.3: validates real match/if status guards vs dead assignments or unrelated http.status", () => {
    const badStatus = evalSelfDogfood(
      "libs/harness/infra/src/bad-status.ts",
      `export const s1 = (x: { readonly status: "a" | "b" }) => {
  const b = x.status === "a"
  return WorkflowStore.invoke({ queryName: "wf_update_unit_status", expectMutation: true, expectedLeaseEpoch: 1, params: { b } })
}
export const s2 = (http: { readonly status: number }) => {
  if (http.status === 200) {
    return WorkflowStore.invokeWithMeta({ queryName: "wf_update_ship_attempt", expectMutation: true, expectedLeaseEpoch: 1 })
  }
}
export const s3 = (input: { readonly status: "a" | "b" }) => {
  if (input.status === "a") {
    return WorkflowStore.invoke({ queryName: "wf_update_unit_status", expectMutation: true, expectedLeaseEpoch: 1 })
  }
}
export const s4 = (current: { readonly status: "running" | "passed" }) => {
  if (current.status === "running") {}
  return (() => WorkflowStore.invoke({ queryName: "wf_update_unit_status", expectMutation: true, expectedLeaseEpoch: 1 }))()
}`,
    )
    expect(
      badStatus.violations.filter((v) => v.rule === "unguarded-workflow-status-update").length,
    ).toBe(4)

    const goodStatus = evalSelfDogfood(
      "libs/harness/infra/src/good-status.ts",
      `import { Effect } from "effect"
export const updateAttemptStatus = (current: { readonly status: "running" | "passed" }) => {
  const { status } = current
  return match(status).with("running", () => Effect.gen(function* () {
    return yield* invokeWorkflowStoreQueryOnce({ queryName: "wf_update_ship_attempt", expectMutation: true, expectedLeaseEpoch: 1 })
  })).with("passed", () => Effect.void).exhaustive()
}
export const readOnly = () => WorkflowStore.invoke({ queryName: "wf_update_ship_attempt", expectMutation: false })`,
    )
    expect(
      goodStatus.violations.filter((v) => v.rule === "unguarded-workflow-status-update"),
    ).toEqual([])
  })

  it("REQ-3.4: SyntaxBans.decide bans sentinel hashes including padStart/padEnd/Array.fill/split-concat while exempting safe repeats", () => {
    const bad = evalSyntaxBans(
      "libs/demo/infra/src/sentinels.ts",
      `export const h1 = "0".repeat(64)
export const h2 = "f".repeat(64)
export const h3 = "${"0".repeat(64)}"
export const h4 = "".padStart(64, "0")
export const h5 = "".padEnd(64, "f")
export const h6 = Array(64).fill("0").join("")
export const h7 = "0".repeat(32) + "0".repeat(32)
export const ok1 = "a".repeat(64)
export const ok2 = "0".repeat(32) + "f".repeat(32)`,
    )
    expect(bad.violations.filter((v) => v.rule === "fabricated-sentinel-hash").length).toBe(7)

    const testExempt = evalSyntaxBans(
      "libs/demo/infra/test/sentinel.test.ts",
      `export const h1 = "0".repeat(64)`,
    )
    expect(testExempt.violations.filter((v) => v.rule === "fabricated-sentinel-hash")).toEqual([])
  })

  it("REQ-3.4: SyntaxBans.decide bans dynamic glob RegExp/CallExpression/split-join while sparing global* and escaper fns", () => {
    const res = evalSyntaxBans(
      "libs/demo/infra/src/regex.ts",
      [
        'export const g1 = (glob: string) => new RegExp(glob.replace(/\\*/g, ".*"))',
        'export const g2 = (pat: string) => RegExp(pat.split("*").join(".*"))',
        'export const g3 = (p: string) => { const gPat = p.replace("?", "."); return globalThis.RegExp(gPat) }',
        'export const g4 = (raw: string) => new RegExp(raw.replace(/[*?]/g, ".*"))',
        'export const g5 = (raw: string) => new RegExp(raw.replace(/[*]/g, ".*"))',
        "export const ok1 = (globalPrefix: string) => new RegExp(globalPrefix)",
        'export const ok2 = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"))',
        'export const ok3 = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\\]\\\\]/g, (m) => "\\\\" + m))',
        'export const ok4 = new RegExp("^abc$")',
      ].join("\n"),
    )
    expect(res.violations.filter((v) => v.rule === "dynamic-glob-regexp").length).toBe(5)
  })

  it("REQ-3.4: SyntaxBans.decide bans unsafe git refs across spawnSync/runGit/local args/before -- while allowing --end-of-options", () => {
    const res = evalSyntaxBans(
      "libs/demo/infra/src/git-refs.ts",
      `import { execFileSync, spawnSync } from "node:child_process"
export const b1 = (ref: string) => execFileSync("git", ["diff", ref])
export const b2 = (ref: string) => spawnSync("git", ["rev-parse", ref])
export const b3 = (ref: string) => runGit(["log", ref])
export const b4 = (ref: string, file: string) => { const args = ["diff", ref, "--", file]; return execFileSync("git", args) }
export const ok1 = (ref: string, file: string) => execFileSync("git", ["diff", "--end-of-options", ref, "--", file])
export const ok2 = (file: string) => execFileSync("git", ["diff", "--", file])
export const ok3 = () => execFileSync("git", ["status"])`,
    )
    expect(res.violations.filter((v) => v.rule === "unsafe-dynamic-git-ref").length).toBe(4)
  })

  it("REQ-3.5: enforces doc subcommand parity (missing doc, uninterpolated policy, missing/extra subcommands) and path/eval isolation", () => {
    expect(WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS).toEqual([
      "start",
      "resume",
      "ship",
      "abort",
      "doctor",
      "complete --phase llm",
    ])
    const reason = explainCommandDenyReason("pnpm harness workflow start", { unitWorkerMode: true })
    for (const subcmd of WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS) expect(reason).toContain(subcmd)
    expect(auditWorkerIsolationSubcommandParity(REPO_ROOT, testHostIo)).toEqual([])

    const validSubcmds = WORKER_ISOLATED_WORKFLOW_SUBCOMMANDS.join("|")
    const tmpMissingDoc = createParityFixture(validSubcmds, { dropLastDoc: true })
    const tmpBadPolicy = createParityFixture(validSubcmds, { interpolatePolicy: false })
    const tmpMissingSub = createParityFixture("start|resume|ship|abort")
    const tmpExtraSub = createParityFixture(`${validSubcmds}|compile`)
    try {
      expect(
        auditWorkerIsolationSubcommandParity(tmpMissingDoc, testHostIo).some((f) =>
          f.nodeId.endsWith(":missing-doc"),
        ),
      ).toBe(true)
      expect(
        auditWorkerIsolationSubcommandParity(tmpBadPolicy, testHostIo).map((f) => f.nodeId),
      ).toEqual(["policy.ts:worker-isolation-subcommands"])
      expect(
        auditWorkerIsolationSubcommandParity(tmpMissingSub, testHostIo).some((f) =>
          f.nodeId.endsWith(":missing-subcmd:doctor"),
        ),
      ).toBe(true)
      expect(
        auditWorkerIsolationSubcommandParity(tmpExtraSub, testHostIo).some((f) =>
          f.nodeId.endsWith(":extra-subcmd:compile"),
        ),
      ).toBe(true)
    } finally {
      for (const dir of [tmpMissingDoc, tmpBadPolicy, tmpMissingSub, tmpExtraSub])
        rmSync(dir, { recursive: true, force: true })
    }

    expect(
      explainCommandDenyReason("pnpm -C apps/harness-cli/. start workflow start", {
        unitWorkerMode: true,
      }),
    ).toBeDefined()
    expect(
      explainCommandDenyReason("bun ./apps/harness-cli/./src/index.ts workflow start", {
        unitWorkerMode: true,
      }),
    ).toBeDefined()
    expect(
      explainCommandDenyReason(`node -e "require('./apps/harness-cli'); workflow start"`, {
        unitWorkerMode: true,
      }),
    ).toBeDefined()
    expect(
      explainCommandDenyReason(`node -e "console.log(1)"`, { unitWorkerMode: true }),
    ).toBeUndefined()
  })

  it("REQ-3.6: flags *Runtime/*Context optional props always populated in src+test (including Effect.fn) while preserving partials/spreads/libs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "w3-runtime-prop-"))
    try {
      mkdirSync(join(tmp, "apps/demo/src"), { recursive: true })
      mkdirSync(join(tmp, "apps/demo/test"), { recursive: true })
      mkdirSync(join(tmp, "libs/ignored/src"), { recursive: true })
      writeFileSync(
        join(tmp, "apps/demo/src/app.ts"),
        `import { Effect } from "effect"
import type { LibOpts } from "../../../libs/ignored/src/lib.js"
import { resolveOptionalDep } from "../../../libs/ignored/src/lib.js"
export interface DemoContext {
  readonly requiredA: string
  readonly alwaysSet?: number
  readonly passThrough?: string | undefined
  readonly libOpt?: string
  readonly libFnOpt?: string
  readonly omittedInTest?: string
  readonly omittedInPartial?: boolean
  readonly clearedBySpread?: number
}
export interface InputOpts { readonly passThrough?: string | undefined }
export const makeDemo = Effect.fn("make")(function* (opts: InputOpts, libOpts: LibOpts, spread: Partial<DemoContext>): Effect.fn.Return<DemoContext> {
  return { requiredA: "ok", alwaysSet: 42, passThrough: opts.passThrough, libOpt: libOpts.opt, libFnOpt: resolveOptionalDep(), omittedInTest: "x", ...spread, alwaysSet: 7 }
})
export const makeGenConditional = (flag: boolean, libOpts: LibOpts): Effect.Effect<DemoContext> =>
  Effect.gen(function* () {
    return flag
      ? { requiredA: "g1", alwaysSet: 1, libOpt: libOpts.opt, libFnOpt: resolveOptionalDep(), omittedInPartial: true, clearedBySpread: 1 }
      : { requiredA: "g2", alwaysSet: 2, libOpt: libOpts.opt, libFnOpt: resolveOptionalDep(), omittedInPartial: true, clearedBySpread: 2 }
  })`,
      )
      writeFileSync(
        join(tmp, "apps/demo/test/app.test.ts"),
        `import type { DemoContext } from "../src/app.js"
export const fixture = (): DemoContext => ({ requiredA: "t", alwaysSet: 1, omittedInPartial: true, clearedBySpread: 2 })`,
      )
      writeFileSync(
        join(tmp, "libs/ignored/src/lib.ts"),
        `export interface LibRuntime { readonly onlyInLibs?: number }
export interface LibOpts { readonly opt?: string }
export function resolveOptionalDep(): string | undefined { return undefined }
export const mk = (): LibRuntime => ({ onlyInLibs: 1 })`,
      )
      const findings = checkAlwaysPopulatedOptionalRuntimeProps(tmp, testHostIo)
      expect(findings.map((f) => f.nodeId)).toEqual(["apps/demo/src/app.ts:DemoContext.alwaysSet"])
      const entropy = Effect.runSync(
        decideGraphEntropy({
          graph: buildHarnessGraph({}),
          workspaceRoot: tmp,
          hostIo: testHostIo,
        }),
      )
      expect(
        entropy.findings.some(
          (f) =>
            f.kind === "always-populated-optional-runtime-prop" &&
            f.nodeId === "apps/demo/src/app.ts:DemoContext.alwaysSet",
        ),
      ).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("REQ-3.7: EarsSpecLint.decide handles ## Requirements, escaped pipes outside/inside code, and flags unescaped pipe splits", () => {
    const cleanMd = `---
id: SPEC-9999
title: Table Pipe Test
status: draft
spans:
  - Parser.run
---
## Requirements
### 1 · Parsing
**Source (\`libs/demo/core/src/parser.ts\`):**

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Event-driven | **When** input has \`a \\| b\`, \`x | y\`, or literal \\| outside code, \`EarsParser\` **shall** parse cleanly. | \`Parser.run\` | UnitTest |
`
    const cleanReport = Effect.runSync(
      decideEarsSpecQuality({ docPath: "libs/harness/docs/specs/9999-test.md", markdown: cleanMd }),
    )
    expect(cleanReport.clean).toBe(true)
    expect(cleanReport.requirements[0]?.effectSymbol).toBe("Parser.run")
    expect(cleanReport.requirements[0]?.verification).toBe("UnitTest")
    expect(cleanReport.requirements[0]?.requirement).toContain("a | b")
    expect(cleanReport.requirements[0]?.requirement).toContain("x | y")

    const brokenMd = `---
id: SPEC-9998
title: Broken Table Pipe Test
status: draft
spans:
  - Parser.run
---
## Requirements
### 1 · Parsing
**Source (\`libs/demo/core/src/parser.ts\`):**

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Event-driven | Unescaped a | b splits cells. | \`Parser.run\` | UnitTest |
`
    const brokenReport = Effect.runSync(
      decideEarsSpecQuality({ docPath: "libs/harness/docs/specs/9998-bad.md", markdown: brokenMd }),
    )
    expect(brokenReport.clean).toBe(false)
  })

  it("REQ-3.11: TestIntegrity.decide passes all 3 real apps/harness-cli adapter test files under line/test budgets", () => {
    const adapterTests = [
      "apps/harness-cli/test/adapter-config.test.ts",
      "apps/harness-cli/test/adapter-isolation-and-cold-start.test.ts",
      "apps/harness-cli/test/adapter-skills-parity.test.ts",
    ]
    for (const rel of adapterTests) {
      const content = readFileSync(join(REPO_ROOT, rel), "utf8")
      expect(content.split(/\r?\n/).length).toBeLessThan(1100)
      const itCount = content.match(/\bit(?:\.effect|\.prop|\.skip|\.only)?\s*\(/g)?.length ?? 0
      expect(itCount).toBeLessThan(25)
      const report = evalTestIntegrity(rel, content)
      expect(report.verdict, `TestIntegrity report for ${rel}`).toBe("clean")
    }
  })
})
