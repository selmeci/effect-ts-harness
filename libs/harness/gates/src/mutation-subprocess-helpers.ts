import { Result } from "effect"
import { match } from "ts-pattern"
import type { SyncHostExecResult } from "@harness/service/host-io"

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_ESCAPE_REGEX = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
)

export const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_REGEX, "")

export type MutantSubprocessOutcome =
  | { readonly kind: "abort"; readonly diagnostic: string }
  | { readonly kind: "outcome"; readonly status: "killed" | "survived" }

export const classifyMutantSubprocessResult = (
  mutantId: string,
  execRes: Result.Result<SyncHostExecResult, unknown>,
): MutantSubprocessOutcome =>
  match(execRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      kind: "abort" as const,
      diagnostic: `[mutation-check] Runner execution threw for mutant '${mutantId}': ${failure instanceof Error ? failure.message : String(failure)}`,
    }))
    .with({ _tag: "Success" }, ({ success }: { readonly success: SyncHostExecResult }) =>
      match(success)
        .with({ _tag: "SpawnFailed" }, (r) => ({
          kind: "abort" as const,
          diagnostic: `[mutation-check] Runner infrastructure failure for mutant '${mutantId}': spawnError=${r.spawnError}`,
        }))
        .with({ _tag: "TimedOut" }, () => ({
          kind: "outcome" as const,
          status: "killed" as const,
        }))
        .with({ _tag: "Signaled" }, () => ({
          kind: "outcome" as const,
          status: "killed" as const,
        }))
        .with({ _tag: "Exited" }, (r) => {
          const cleanStdout = stripAnsi(r.stdout)
          const cleanStderr = stripAnsi(r.stderr)
          const combinedOutput = `${cleanStdout}\n${cleanStderr}`
          const isInfraMissingRunner =
            /\bERR_PNPM_|Command\s+["']?vitest["']?\s+not found|Failed to load config|Failed to resolve import|Cannot find (?:module|package)|No test (?:files|suite) found|Startup Error/i.test(
              combinedOutput,
            )
          if (isInfraMissingRunner || r.exitCode < 0 || r.exitCode > 1) {
            const reasons: Array<string> = [`exitCode=${r.exitCode}`]
            if (cleanStderr.trim().length > 0) reasons.push(`stderr=${cleanStderr.trim()}`)
            return {
              kind: "abort" as const,
              diagnostic: `[mutation-check] Runner infrastructure failure for mutant '${mutantId}': ${reasons.join(", ")}`,
            }
          }
          if (r.exitCode === 1) {
            const hasVitestTestFailureEvidence =
              /\bTests\s+[1-9]\d*\s+failed\b/.test(combinedOutput)
            const hasMutantBreakageEvidence =
              /\bSyntaxError:|\bERR_MODULE_NOT_FOUND\b/.test(combinedOutput) ||
              /\bTests\s+no tests\b/i.test(combinedOutput) ||
              /Transform failed with \d+ error/i.test(combinedOutput)
            if (hasVitestTestFailureEvidence || hasMutantBreakageEvidence) {
              return { kind: "outcome" as const, status: "killed" as const }
            }
            const reasons: Array<string> = [
              `exitCode=${r.exitCode}`,
              "missingVitestFailureEvidence=true",
            ]
            if (cleanStderr.trim().length > 0) reasons.push(`stderr=${cleanStderr.trim()}`)
            return {
              kind: "abort" as const,
              diagnostic: `[mutation-check] Runner infrastructure failure for mutant '${mutantId}': ${reasons.join(", ")}`,
            }
          }
          return { kind: "outcome" as const, status: "survived" as const }
        })
        .exhaustive(),
    )
    .exhaustive()
