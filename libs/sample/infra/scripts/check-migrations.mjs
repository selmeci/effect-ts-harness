// Migration drift gate (mvp.md "Migration gates in verify").
// Copies the committed migrations snapshot to a temp folder and runs
// `drizzle-kit generate` against it:
//   no new .sql files                        -> exit 0 (schema and migrations in sync)
//   new .sql files without destructive SQL   -> exit 1 (schema changed without a committed migration)
//   new .sql files with DROP / table rebuild -> exit 2 (ESCALATE to the human)
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
// oxlint-disable-next-line @nx/enforce-module-boundaries
import { checkMigrationSqlSafety } from "../../../harness/gates/src/migration-check.ts"

const packageRoot = join(import.meta.dirname, "..")
const migrationsDir = join(packageRoot, "migrations")
const schemaPath = join(packageRoot, "src/db/schema.ts")

const listSql = async (dir) => {
  try {
    return (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(".sql")).sort()
  } catch {
    return []
  }
}

const run = async () => {
  const temp = await mkdtemp(join(tmpdir(), "drizzle-drift-"))
  try {
    try {
      await cp(migrationsDir, join(temp, "migrations"), { recursive: true })
    } catch {
      console.error("migration check: FAIL — no committed baseline migration in migrations/")
      process.exitCode = 1
      return
    }

    const outDir = join(temp, "migrations")
    const before = await listSql(outDir)

    execFileSync(
      "pnpm",
      [
        "exec",
        "drizzle-kit",
        "generate",
        "--dialect",
        "sqlite",
        "--schema",
        schemaPath,
        "--out",
        outDir,
        "--name",
        "drift",
      ],
      { stdio: "pipe", cwd: packageRoot },
    )

    const newFiles = (await listSql(outDir)).filter((file) => !before.includes(file))
    if (newFiles.length === 0) {
      console.log("migration check: schema and committed migrations are in sync")
      process.exitCode = 0
      return
    }

    const sqlFiles = []
    for (const file of newFiles) {
      const sql = await readFile(join(outDir, file), "utf8")
      sqlFiles.push({ file, sql })
    }

    const report = checkMigrationSqlSafety(sqlFiles)
    if (report.requiresEscalation) {
      for (const v of report.violations) {
        console.error(`migration check: ESCALATE — ${v.message} (${v.file}):\n${v.statement}`)
      }
      process.exitCode = 2
      return
    }

    console.error(
      `migration check: FAIL — schema changed without a committed migration:\n${newFiles.join("\n")}`,
    )
    process.exitCode = 1
    return
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

await run()
