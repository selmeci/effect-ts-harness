import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import { decideGuardCommand, makeMockDecisionModelLayer } from "../src/index.js"

const ProtectedCommandTargetSchema = Schema.Literals([
  ".git/harness/daemon.sock",
  ".git/harness/auth-tokens.json",
  ".git/harness/daemon.lock",
  ".env",
  ".env.local",
  ".dev.vars",
])

const WrapperModeSchema = Schema.Literals([
  "direct",
  "env",
  "timeout",
  "sh-c",
  "subshell",
  "var-expand",
])

const QuoteModeSchema = Schema.Literals(["raw", "single", "double", "backslash"])

const buildObfuscatedCommand = (
  target: typeof ProtectedCommandTargetSchema.Type,
  quoteMode: typeof QuoteModeSchema.Type,
  wrapperMode: typeof WrapperModeSchema.Type,
): string => {
  const arg = match(quoteMode)
    .with("raw", () => target)
    .with("single", () => `'${target}'`)
    .with("double", () => `"${target}"`)
    .with("backslash", () => target.replace(/(?=[a-z])/, "\\"))
    .exhaustive()

  return match(wrapperMode)
    .with("env", () => `env cat ${arg}`)
    .with("timeout", () => `timeout 5 cat ${arg}`)
    .with("sh-c", () => `sh -c "cat ${arg.replace(/"/g, '\\"')}"`)
    .with("subshell", () => `cat $(echo ${arg})`)
    .with("var-expand", () => `F=${arg}; cat "$F"`)
    .with("direct", () => `cat ${arg}`)
    .exhaustive()
}

const BenignSlugSchema = Schema.Literals(["alpha", "beta", "gamma"])

describe("Harness.decideGuardCommand Adversarial Property Matrix (SPEC-0028 REQ-2.1, REQ-2.2)", () => {
  it.effect.prop(
    "never auto-allows obfuscated secret or daemon credential access even when advisory DecisionModel returns low risk",
    {
      target: ProtectedCommandTargetSchema,
      quoteMode: QuoteModeSchema,
      wrapperMode: WrapperModeSchema,
      unitWorkerMode: Schema.Boolean,
    },
    ({ target, quoteMode, wrapperMode, unitWorkerMode }) =>
      Effect.gen(function* () {
        const command = buildObfuscatedCommand(target, quoteMode, wrapperMode)
        const result = yield* decideGuardCommand({ command, unitWorkerMode }).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              destructiveProb: 0.05,
              secretAccessProb: 0.05,
              exfiltrationProb: 0.05,
            }),
          ),
        )
        expect(result.verdict).toBe("deny")
      }),
  )

  it.effect.prop(
    "allows canonical benign workspace commands under coordinator decideGuardCommand",
    {
      slug: BenignSlugSchema,
      unitWorkerMode: Schema.Boolean,
    },
    ({ slug, unitWorkerMode }) =>
      Effect.gen(function* () {
        const result = yield* decideGuardCommand({
          command: `pnpm vitest run libs/harness/domain/test/${slug}.test.ts`,
          unitWorkerMode,
        }).pipe(Effect.provide(makeMockDecisionModelLayer()))
        expect(result.verdict).toBe("allow")
      }),
  )
})
