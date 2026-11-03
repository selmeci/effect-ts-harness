import { existsSync, readFileSync } from "node:fs"
import { Effect } from "effect"

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

export const decideMigrationSafety = Effect.fn("MigrationSafety.decide")(function* (
  input: MigrationSafetyInput,
) {
  yield* Effect.void

  const violations: Array<MigrationViolation> = []

  for (const { file, sql } of input.files) {
    const commentStrippedSql = sql
      .replace(/--> statement-breakpoint/g, ";")
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")

    const stmts = commentStrippedSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const stmt of stmts) {
      if (
        /\bDROP\s+(TABLE|COLUMN|INDEX|TRIGGER|VIEW)\b/i.test(stmt) ||
        /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i.test(stmt)
      ) {
        violations.push({
          kind: "drop-statement",
          file,
          statement: stmt,
          message: `Destructive DROP statement in "${file}" requires human approval (ESCALATE).`,
        })
      } else if (
        /\bCREATE\s+TABLE\s+[`"']?__new_/i.test(stmt) ||
        /\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i.test(stmt)
      ) {
        violations.push({
          kind: "table-rebuild",
          file,
          statement: stmt,
          message: `SQLite table rebuild (__new_ / foreign_keys=OFF) in "${file}" requires human approval (ESCALATE).`,
        })
      } else if (
        /\bALTER\s+TABLE\b[\s\S]*?\bADD\b[\s\S]*?\bNOT\s+NULL\b/i.test(stmt) &&
        !/\bADD\b[\s\S]*?\bDEFAULT\b/i.test(stmt)
      ) {
        violations.push({
          kind: "add-not-null-without-default",
          file,
          statement: stmt,
          message: `ALTER TABLE ADD COLUMN NOT NULL without DEFAULT in "${file}" fails on non-empty tables and breaks rolling deploys (ESCALATE).`,
        })
      }
    }
  }

  return {
    safe: violations.length === 0,
    requiresEscalation: violations.length > 0,
    violations,
  } satisfies MigrationSafetyReport
})

export const checkMigrationSqlSafety = (
  files: ReadonlyArray<MigrationSqlFile>,
): MigrationSafetyReport => Effect.runSync(decideMigrationSafety({ files }))

export const checkMigrationFiles = (filePaths: ReadonlyArray<string>): MigrationSafetyReport => {
  const files: Array<MigrationSqlFile> = []
  for (const file of filePaths) {
    const sql = Effect.runSync(
      Effect.try({
        try: () => (existsSync(file) ? readFileSync(file, "utf8") : ""),
        catch: () => "",
      }).pipe(Effect.orElseSucceed(() => "")),
    )
    if (sql.length > 0) {
      files.push({ file, sql })
    }
  }
  return checkMigrationSqlSafety(files)
}
