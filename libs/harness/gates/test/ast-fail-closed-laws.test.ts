import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AstGatePackageTag, AstSourceContent, AstSourceFilePath } from "@harness/contract"
import { AstGateCache } from "../src/ast-cache.js"
import { isSilentFsFallbackCheckedPath } from "../src/plugins/ast-gate-law-helpers.js"
import { SelfDogfooding } from "../src/plugins/self-dogfooding-plugin.js"

const evalAstFile = (
  filePath: string,
  content: string,
  pkg: "app" | "contract" | "domain" | "infra" | "service" | "test" = "infra",
) =>
  AstGateCache.decide({
    files: [
      {
        filePath: AstSourceFilePath.make(filePath),
        content: AstSourceContent.make(content),
        packageTag: AstGatePackageTag.make(pkg),
      },
    ],
  })

const evalDogfoodFile = (filePath: string, content: string) =>
  SelfDogfooding.decide({
    files: [
      { filePath: AstSourceFilePath.make(filePath), content: AstSourceContent.make(content) },
    ],
  })

describe("AST Fail-Closed & Interrupt-Safe Laws (SPEC-0025 REQ-2.1..REQ-2.4)", () => {
  it.effect("flags untyped-catch-cause-interrupt-leak without isPureInterruptCause AST guard", () =>
    Effect.gen(function* () {
      const bareCatch = yield* evalAstFile(
        "libs/sample/infra/src/a.ts",
        "export const run = eff.pipe(Effect.catchCause(() => Effect.succeed(0)))",
      )
      expect(bareCatch.violations.map((v) => v.rule)).toContain(
        "untyped-catch-cause-interrupt-leak",
      )

      const commentSpoof = yield* evalAstFile(
        "apps/harness-cli/src/b.ts",
        "export const run = Effect.catchCause(eff, (c) => /* isPureInterruptCause */ Effect.void)",
        "app",
      )
      expect(commentSpoof.violations.map((v) => v.rule)).toContain(
        "untyped-catch-cause-interrupt-leak",
      )

      const refHandler = yield* evalAstFile(
        "libs/harness/infra/src/c.ts",
        "export const run = eff.pipe(Effect.catchCause(fallbackHandler))",
      )
      expect(refHandler.violations.map((v) => v.rule)).toContain(
        "untyped-catch-cause-interrupt-leak",
      )

      const guarded = yield* evalAstFile(
        "libs/sample/infra/src/ok.ts",
        "export const run = eff.pipe(Effect.catchCause((c) => isPureInterruptCause(c) ? Effect.failCause(c) : Effect.succeed(0)))",
      )
      expect(guarded.violations.map((v) => v.rule)).not.toContain(
        "untyped-catch-cause-interrupt-leak",
      )

      const catchCauseIfReport = yield* evalAstFile(
        "libs/sample/infra/src/if.ts",
        "export const run = eff.pipe(Effect.catchCauseIf(isExpected, () => Effect.void))",
      )
      expect(catchCauseIfReport.violations.map((v) => v.rule)).not.toContain(
        "untyped-catch-cause-interrupt-leak",
      )

      const testExempt = yield* evalAstFile(
        "libs/sample/infra/test/a.test.ts",
        "export const run = eff.pipe(Effect.catchCause(() => Effect.succeed(0)))",
        "test",
      )
      expect(testExempt.violations.map((v) => v.rule)).not.toContain(
        "untyped-catch-cause-interrupt-leak",
      )
    }),
  )

  it.effect(
    "flags silent-decode-fallback on decodeOption fallbacks and silent workflow catchTag",
    () =>
      Effect.gen(function* () {
        const badSnippets = [
          "export const a = Schema.decodeOption(S)(raw) ?? []",
          'export const b = Schema.decodeUnknownOption(S)(raw) ?? ""',
          "export const c = Option.getOrElse(Schema.decodeOption(S)(raw), () => [])",
          "export const d = Schema.decodeUnknownOption(S)(raw).pipe(Option.getOrElse(() => undefined))",
          "export const e = pipe(Schema.decodeOption(S)(raw), Option.getOrElse(() => ({})))",
          'export const f = eff.pipe(Effect.catchTag("WorkflowStoreUnavailableError", () => Effect.succeed([])))',
          'export const g = Effect.catchTag(eff, "WriterLeaseHeldError", () => Effect.void)',
          'export const h = eff.pipe(Effect.catchTag("WorkflowStoreUnavailableError", () => { return Effect.succeed(Option.none()) }))',
        ]
        for (const [idx, code] of badSnippets.entries()) {
          const report = yield* evalAstFile(`libs/harness/infra/src/bad-${idx}.ts`, code)
          expect(
            report.violations.map((v) => v.rule),
            `snippet #${idx}: ${code}`,
          ).toContain("silent-decode-fallback")
        }

        const goodSnippets = [
          'export const ok1 = match(Schema.decodeUnknownOption(S)(raw)).with({ _tag: "Some" }, ({ value }) => Effect.succeed(value)).with({ _tag: "None" }, () => Effect.fail(err)).exhaustive()',
          'export const ok2 = eff.pipe(Effect.catchTag("WorkflowStoreUnavailableError", (err) => isDown(err.reason) ? Effect.succeed(offlineSummary) : Effect.fail(err)))',
          'export const ok3 = eff.pipe(Effect.catchTag("WorkflowStoreUnavailableError", (err) => Effect.succeed([{ _tag: "Rejected", error: err.reason }])))',
        ]
        for (const [idx, code] of goodSnippets.entries()) {
          const report = yield* evalAstFile(`libs/harness/infra/src/good-${idx}.ts`, code)
          expect(
            report.violations.map((v) => v.rule),
            `safe snippet #${idx}`,
          ).not.toContain("silent-decode-fallback")
        }
      }),
  )

  it.effect(
    "flags provision-tap-error-leak inside provision* and acquireRelease acquire blocks",
    () =>
      Effect.gen(function* () {
        const badProvision = yield* evalDogfoodFile(
          "libs/harness/infra/src/prov.ts",
          'export const provisionWorktree = Effect.fn("W.provision")(function* () { return yield* step.pipe(Effect.tapError(() => rollback())) })',
        )
        expect(badProvision.violations.map((v) => v.rule)).toContain("provision-tap-error-leak")

        const badAcquire = yield* evalDogfoodFile(
          "libs/harness/infra/src/acq.ts",
          "export const layer = Effect.acquireRelease(step.pipe(Effect.tapError(() => closeSocket())), () => cleanup())",
        )
        expect(badAcquire.violations.map((v) => v.rule)).toContain("provision-tap-error-leak")

        const safeLogOnly = yield* evalDogfoodFile(
          "libs/harness/infra/src/log.ts",
          "export const provisionModel = () => step.pipe(Effect.tapError((e) => Effect.logWarning(e.message)))",
        )
        expect(safeLogOnly.violations.map((v) => v.rule)).not.toContain("provision-tap-error-leak")

        const safeReleaseAndOnExit = yield* evalDogfoodFile(
          "libs/harness/infra/src/ok.ts",
          "export const layer = Effect.acquireRelease(step.pipe(Effect.onExit(() => closeSocket())), () => cleanup().pipe(Effect.tapError(() => rollback())))",
        )
        expect(safeReleaseAndOnExit.violations.map((v) => v.rule)).not.toContain(
          "provision-tap-error-leak",
        )
      }),
  )

  it.effect("enforces silent-gate-fs-fallback across libs/harness/infra/src/", () =>
    Effect.gen(function* () {
      expect(isSilentFsFallbackCheckedPath("libs/harness/infra/src/workflow-maintenance.ts")).toBe(
        true,
      )
      expect(
        isSilentFsFallbackCheckedPath("libs/harness/graph/src/extractor/compiler-session.ts"),
      ).toBe(false)

      const infraPath = "libs/harness/infra/src/fs-bad.ts"
      const badCode = `
        export const readLock = (hostIo: SyncHostIo, p: string) =>
          match(Result.try(() => hostIo.readTextSync(p)))
            .with({ _tag: "Failure" }, () => undefined)
            .with({ _tag: "Success" }, ({ success }) => success)
            .exhaustive()
      `
      const astReport = yield* evalAstFile(infraPath, badCode)
      const dogfoodReport = yield* evalDogfoodFile(infraPath, badCode)
      expect(astReport.violations.map((v) => v.rule)).toContain("silent-gate-fs-fallback")
      expect(dogfoodReport.violations.map((v) => v.rule)).toContain("silent-gate-fs-fallback")
    }),
  )

  it.effect.prop(
    "deterministically classifies fail-closed violations across repeated runs",
    {
      scenarios: Schema.Array(Schema.Literals(["catchCause", "decodeFallback", "tapError"])).pipe(
        Schema.check(Schema.isBetweenLength(1, 3)),
      ),
    },
    ({ scenarios }) =>
      Effect.gen(function* () {
        const snippetByKind = {
          catchCause: "export const f1 = eff.pipe(Effect.catchCause(() => Effect.void))",
          decodeFallback: "export const f2 = Schema.decodeOption(S)(x) ?? []",
          tapError: "export const f3 = () => step.pipe(Effect.tapError(() => rollback()))",
        } as const
        const code = scenarios.map((k) => snippetByKind[k]).join("\n")
        const path = "libs/harness/infra/src/provisionWork.ts"
        const r1 = yield* evalAstFile(path, code)
        const r2 = yield* evalAstFile(path, code)
        const d1 = yield* evalDogfoodFile(path, code)
        const d2 = yield* evalDogfoodFile(path, code)
        expect(r1.violations.map((v) => v.rule)).toEqual(r2.violations.map((v) => v.rule))
        expect(d1.violations.map((v) => v.rule)).toEqual(d2.violations.map((v) => v.rule))
      }),
  )
})
