import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  NonNegativeCount,
  OmnigraphDiagnosticCode,
  type OmnigraphLintDiagnostic,
  type OmnigraphLintInput,
  OmnigraphLintStatus,
  OmnigraphTargetName,
} from "@harness/contract"
import { decideOmnigraphLint } from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import { resolveDefaultOmnigraphBin } from "./omnigraph-safety-helpers.js"

const RawOmnigraphLintDiagnosticSchema = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  targetName: Schema.optional(Schema.NullOr(Schema.String)),
  target_name: Schema.optional(Schema.NullOr(Schema.String)),
  target: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.optional(Schema.Literals(["error", "warning", "info"])),
})

const OmnigraphLintJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.optional(Schema.NullOr(Schema.String)),
    queries_processed: Schema.optional(Schema.NullOr(Schema.Finite)),
    findings: Schema.optional(Schema.NullOr(Schema.Array(RawOmnigraphLintDiagnosticSchema))),
    diagnostics: Schema.optional(Schema.NullOr(Schema.Array(RawOmnigraphLintDiagnosticSchema))),
  }),
)

export type OfflineOmnigraphLintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export const runOfflineOmnigraphLintGate = (
  repoRoot: string,
  omnigraphBin: string = resolveDefaultOmnigraphBin(),
): Effect.Effect<OfflineOmnigraphLintResult> =>
  Effect.gen(function* () {
    if (!nodeSyncHostIo.existsSync(omnigraphBin)) {
      return {
        ok: false as const,
        message: `omnigraph binary not found at ${omnigraphBin}; cannot run offline lint gate`,
      }
    }
    const schemaPath = join(repoRoot, "libs", "harness", "graph", "schema.pg")
    const queryPath = join(repoRoot, "libs", "harness", "graph", "queries", "harness.gq")
    if (!nodeSyncHostIo.existsSync(schemaPath) || !nodeSyncHostIo.existsSync(queryPath)) {
      return {
        ok: false as const,
        message: `Missing Omnigraph schema (${schemaPath}) or query (${queryPath}) file; cannot run offline lint gate`,
      }
    }

    const execAttempt = Result.try(() =>
      nodeSyncHostIo.execFileSync(
        omnigraphBin,
        ["lint", "--schema", schemaPath, "--query", queryPath, "--json"],
        { cwd: repoRoot, timeoutMs: 15_000 },
      ),
    )

    const execOutcome = match(execAttempt)
      .with({ _tag: "Failure" }, ({ failure }) => ({
        _tag: "ExecError" as const,
        message: `omnigraph lint execution failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      }))
      .with({ _tag: "Success" }, ({ success: res }) =>
        match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => ({
            _tag: "Exited" as const,
            exitCode,
            stdout,
            stderr,
          }))
          .with({ _tag: "TimedOut" }, ({ stderr }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint timed out: ${stderr}`,
          }))
          .with({ _tag: "Signaled" }, ({ signal, stderr }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint killed by ${signal}: ${stderr}`,
          }))
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => ({
            _tag: "ExecError" as const,
            message: `omnigraph lint spawn failed: ${spawnError}`,
          }))
          .exhaustive(),
      )
      .exhaustive()

    return yield* match(execOutcome)
      .with({ _tag: "ExecError" }, ({ message }) =>
        Effect.succeed({ ok: false as const, message }),
      )
      .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
        Effect.gen(function* () {
          const parsedOpt = Schema.decodeOption(OmnigraphLintJsonSchema)(stdout)
          const parsed = match(parsedOpt)
            .with({ _tag: "Some" }, ({ value }) => value)
            .with({ _tag: "None" }, () => undefined)
            .exhaustive()

          if (parsed === undefined) {
            const detail = stderr.trim() || stdout.trim() || `exitCode=${exitCode}`
            return {
              ok: false as const,
              message: `omnigraph lint returned invalid JSON (${detail})`,
            }
          }

          const rawDiagnostics = parsed.findings ?? parsed.diagnostics ?? []
          const diagnostics: Array<OmnigraphLintDiagnostic> = rawDiagnostics.map((d) => {
            const rawCode = (d.code ?? "LINT_ERROR").trim() || "LINT_ERROR"
            const rawMsg = (d.message ?? "Omnigraph lint diagnostic").trim() || "Omnigraph lint diagnostic"
            const rawTarget = (d.targetName ?? d.target_name ?? d.target ?? null)?.trim() ?? null
            return {
              code: OmnigraphDiagnosticCode.make(rawCode),
              message: ErrorReasonMessage.make(rawMsg),
              targetName: rawTarget && rawTarget.length > 0 ? OmnigraphTargetName.make(rawTarget) : null,
              severity: d.severity ?? "error",
            }
          })

          const statusOk = match(
            Schema.decodeUnknownOption(OmnigraphLintStatus)(parsed.status?.trim()),
          )
            .with({ _tag: "Some" }, ({ value }) =>
              match(value)
                .with("ok", () => true)
                .with("error", () => false)
                .exhaustive(),
            )
            .with({ _tag: "None" }, () => false)
            .exhaustive()

          const lintInput: OmnigraphLintInput = {
            statusOk,
            queriesProcessed: NonNegativeCount.make(
              Math.max(0, Math.floor(parsed.queries_processed ?? 0)),
            ),
            diagnostics,
            policy: "fail-on-error",
          }

          const lintRes = yield* decideOmnigraphLint(lintInput).pipe(
            Effect.map((report) => ({ _tag: "Report" as const, report })),
            Effect.catchTag("OmnigraphLintError", (err) => Effect.succeed({ _tag: "Err" as const, err })),
          )

          return match(lintRes)
            .with({ _tag: "Err" }, ({ err }) => ({
              ok: false as const,
              message: `omnigraph lint failed (${err.errorCount} errors): ${err.diagnosticsSummary}`,
            }))
            .with({ _tag: "Report" }, ({ report }) =>
              match(report)
                .with({ verdict: "violated" }, ({ violations }) => {
                  const summary = violations.map((v) => `[${v._tag}] ${v.message}`).join("; ")
                  return { ok: false as const, message: `omnigraph lint failed: ${summary}` }
                })
                .with({ verdict: "clean" }, () => {
                  if (exitCode !== 0) {
                    const detail = stderr.trim() || `exitCode=${exitCode}`
                    return { ok: false as const, message: `omnigraph lint exited with ${detail}` }
                  }
                  return { ok: true as const }
                })
                .exhaustive(),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  })
