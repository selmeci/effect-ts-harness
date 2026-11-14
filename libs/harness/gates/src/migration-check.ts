import { Effect, Result } from "effect"
import { match, P } from "ts-pattern"
import type { SyncHostIo } from "@harness/service"

export type MigrationViolationKind =
  | "drop-statement"
  | "table-rebuild"
  | "add-not-null-without-default"

export interface MigrationViolation {
  readonly kind: MigrationViolationKind
  readonly file: string
  readonly statement: string
  readonly message: string
}

export interface MigrationSqlFile {
  readonly file: string
  readonly sql: string
}

export interface MigrationSafetyInput {
  readonly files: ReadonlyArray<MigrationSqlFile>
}

export interface MigrationSafetyReport {
  readonly safe: boolean
  readonly requiresEscalation: boolean
  readonly violations: ReadonlyArray<MigrationViolation>
}

export const checkMigrationSqlSafety = (
  files: ReadonlyArray<MigrationSqlFile>,
): MigrationSafetyReport => {
  const violations: Array<MigrationViolation> = []

  for (const { file, sql } of files) {
    const commentStrippedSql = sql
      .replace(/--> statement-breakpoint/g, ";")
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")

    const stmts = commentStrippedSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const stmt of stmts) {
      match(stmt)
        .with(
          P.when(
            (s) =>
              /\bDROP\s+(TABLE|COLUMN|INDEX|TRIGGER|VIEW)\b/i.test(s) ||
              /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i.test(s),
          ),
          (s) => {
            violations.push({
              kind: "drop-statement",
              file,
              statement: s,
              message: `Destructive DROP statement in "${file}" requires human approval (ESCALATE).`,
            })
          },
        )
        .with(
          P.when(
            (s) =>
              /\bCREATE\s+TABLE\s+[`"']?__new_/i.test(s) ||
              /\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i.test(s),
          ),
          (s) => {
            violations.push({
              kind: "table-rebuild",
              file,
              statement: s,
              message: `SQLite table rebuild (__new_ / foreign_keys=OFF) in "${file}" requires human approval (ESCALATE).`,
            })
          },
        )
        .with(
          P.when(
            (s) =>
              /\bALTER\s+TABLE\b[\s\S]*?\bADD\b[\s\S]*?\bNOT\s+NULL\b/i.test(s) &&
              !/\bADD\b[\s\S]*?\bDEFAULT\b/i.test(s),
          ),
          (s) => {
            violations.push({
              kind: "add-not-null-without-default",
              file,
              statement: s,
              message: `ALTER TABLE ADD COLUMN NOT NULL without DEFAULT in "${file}" fails on non-empty tables and breaks rolling deploys (ESCALATE).`,
            })
          },
        )
        .otherwise(() => {})
    }
  }

  return {
    safe: violations.length === 0,
    requiresEscalation: violations.length > 0,
    violations,
  } satisfies MigrationSafetyReport
}

export const decideMigrationSafety = Effect.fn("MigrationSafety.decide")(function* (
  input: MigrationSafetyInput,
) {
  return yield* Effect.succeed(checkMigrationSqlSafety(input.files))
})

export const checkMigrationFiles = (
  filePaths: ReadonlyArray<string>,
  hostIo: SyncHostIo,
): MigrationSafetyReport => {
  const files: Array<MigrationSqlFile> = []
  for (const file of filePaths) {
    const sql = Result.getOrElse(
      Result.try(() => (hostIo.existsSync(file) ? hostIo.readTextSync(file) : "")),
      () => "",
    )
    if (sql.length > 0) {
      files.push({ file, sql })
    }
  }
  return checkMigrationSqlSafety(files)
}
