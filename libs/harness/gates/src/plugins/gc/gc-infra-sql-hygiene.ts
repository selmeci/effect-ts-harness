import { relative } from "node:path"
import type { SyncHostIo } from "@harness/service/host-io"
import { checkMigrationSqlSafety } from "../../migration-check.js"
import { analyzeSqliteMigratorFromRecordAst } from "../sqlite-migrator-ast.js"
import {
  extractBalancedBraces,
  extractBalancedParens,
  extractTopLevelObjectAnalysis,
  type GcFinding,
  readTextOrReport,
} from "./gc-helpers.js"

const SAFE_BRAND_MAKE_RECEIVERS =
  /^(?:ErrorMessage|Layer|Effect|Context|Option|Array|Set|Map|Record|LocalProjection|CrossAggregateProjection|EventBus|SqlSchema|Migrator|SqliteMigrator)$/

const collectPackageNamedMigrationBodies = (
  srcFiles: ReadonlyArray<string>,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
): ReadonlyMap<string, string> => {
  const packageNamedMigrationBodies = new Map<string, string>()
  for (const file of srcFiles) {
    const content = readTextOrReport(file, hostIo, repoRoot, findings)
    if (content === undefined) continue
    const noComments = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "")
    const mvRegex =
      /(?:const|let)\s+([A-Za-z0-9_$]*[Mm]igrations[A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{/g
    let mvMatch: RegExpExecArray | null
    while ((mvMatch = mvRegex.exec(noComments)) !== null) {
      const balanced = extractBalancedBraces(
        noComments,
        mvMatch.index + mvMatch[0].lastIndexOf("{"),
      )
      if (balanced !== undefined) packageNamedMigrationBodies.set(mvMatch[1]!, balanced.body)
    }
  }
  return packageNamedMigrationBodies
}

export const evaluateInfraSqlAndSqliteHygiene = (
  repoRoot: string,
  scope: string,
  srcFiles: ReadonlyArray<string>,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const packageNamedMigrationBodies = collectPackageNamedMigrationBodies(
    srcFiles,
    hostIo,
    repoRoot,
    findings,
  )
  const defaultTableMigratorRoots = new Map<string, string>()

  for (const file of srcFiles) {
    const relFilePath = relative(repoRoot, file).replace(/\\/g, "/")
    const content = readTextOrReport(file, hostIo, repoRoot, findings)
    if (content === undefined) continue
    const noComments = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "")

    const nodeSqliteRegex =
      /\b(?:import\s*\(\s*|require\s*\(\s*|(?:import|from)\s+)["'](node:sqlite|sqlite|better-sqlite3)["']/g
    let sqliteMatch: RegExpExecArray | null
    while ((sqliteMatch = nodeSqliteRegex.exec(noComments)) !== null) {
      const mod = sqliteMatch[1]!
      findings.push({
        kind: "node-sqlite-in-infra",
        nodeId: `${relFilePath}:${mod}`,
        location: relFilePath,
        message: `Do not import '${mod}' in '${relFilePath}' — Cloudflare Durable Object SQLite and D1 storages in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
        action: `Remove '${mod}' import and execute storage against @alchemy.run/cloudflare-runtime.`,
      })
    }

    const codeWithoutStrings = noComments.replace(
      /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,
      '""',
    )
    const brandMakeRegex = /\b([A-Z][A-Za-z0-9_$]*)\.make\s*\(/g
    let bmMatch: RegExpExecArray | null
    const reportedBrandMakeIds = new Set<string>()
    while ((bmMatch = brandMakeRegex.exec(codeWithoutStrings)) !== null) {
      const brandName = bmMatch[1]!
      if (SAFE_BRAND_MAKE_RECEIVERS.test(brandName)) continue
      const parenBalanced = extractBalancedParens(
        codeWithoutStrings,
        bmMatch.index + bmMatch[0].lastIndexOf("("),
      )
      if (parenBalanced !== undefined) {
        const colMatch =
          /\b([A-Za-z_$][\w$]*\.[a-z]+_[a-z0-9_]+|(?:row|record|entry)\.[a-z][A-Za-z0-9_]*)\b(?!\s*\()/.exec(
            parenBalanced.body,
          )
        if (colMatch !== null) {
          const nodeId = `${relFilePath}:${brandName}.make(${colMatch[1]!})`
          if (!reportedBrandMakeIds.has(nodeId)) {
            reportedBrandMakeIds.add(nodeId)
            findings.push({
              kind: "untrusted-row-brand-make",
              nodeId,
              location: relFilePath,
              message: `Unvalidated "${brandName}.make(...${colMatch[1]!}...)" on SQLite row column in "${relFilePath}" — ".make()" throws an untyped defect on corrupt/fractional SQLite values; decode with "Schema.decodeUnknownOption(${brandName})" and fail with a domain TaggedError.`,
              action: `Replace "${brandName}.make(...${colMatch[1]!}...)" with "Schema.decodeUnknownOption(${brandName})" and match({ _tag: "Some" }, { _tag: "None" }).exhaustive().`,
            })
          }
        }
      }
    }

    const hasMigratorImport = /\bimport\b[\s\S]*?\b(?:SqliteMigrator|Migrator)\b/.test(noComments)
    const namedMigrationBodies = new Map<string, string>()
    const allowedDdlSpans: Array<[number, number]> = []
    const mvRegex =
      /(?:const|let)\s+([A-Za-z0-9_$]*[Mm]igrations[A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{/g
    let mvMatch: RegExpExecArray | null
    while ((mvMatch = mvRegex.exec(noComments)) !== null) {
      const balanced = extractBalancedBraces(
        noComments,
        mvMatch.index + mvMatch[0].lastIndexOf("{"),
      )
      if (balanced !== undefined) {
        namedMigrationBodies.set(mvMatch[1]!, balanced.body)
        if (hasMigratorImport) {
          allowedDdlSpans.push([mvMatch.index + mvMatch[0].lastIndexOf("{"), balanced.endIndex])
        }
      }
    }

    const fromRecordBodies: Array<string> = []
    const frRegex = /\bfromRecord\s*(?:<[^>]+>)?\s*\(\s*(\{|[A-Za-z_$][\w$]*)/g
    let frMatch: RegExpExecArray | null
    while ((frMatch = frRegex.exec(noComments)) !== null) {
      if (frMatch[1] === "{") {
        const balanced = extractBalancedBraces(
          noComments,
          frMatch.index + frMatch[0].lastIndexOf("{"),
        )
        if (balanced !== undefined) {
          fromRecordBodies.push(balanced.body)
          if (hasMigratorImport) {
            allowedDdlSpans.push([frMatch.index + frMatch[0].lastIndexOf("{"), balanced.endIndex])
          }
        }
      } else {
        fromRecordBodies.push(`...${frMatch[1]!}`)
      }
    }

    const meRegex = /\b(?:SqliteMigrator|Migrator)\.(?:run|layer)\s*(?:<[^>]+>)?\s*\(\s*\{/g
    let meMatch: RegExpExecArray | null
    while ((meMatch = meRegex.exec(noComments)) !== null) {
      const cfg = extractBalancedBraces(noComments, meMatch.index + meMatch[0].lastIndexOf("{"))
      if (cfg !== undefined) {
        const { keys: cfgKeys } = extractTopLevelObjectAnalysis(cfg.body)
        if (!cfgKeys.includes("table")) {
          let rootKey: string | undefined
          for (const kv of packageNamedMigrationBodies.keys()) {
            if (new RegExp(`\\b${kv}\\b`).test(cfg.body)) {
              rootKey = kv
              break
            }
          }
          if (rootKey === undefined) {
            const inlineMatch = /["']([1-9]\d*_[a-z0-9_]+)["']\s*:/.exec(cfg.body)
            if (inlineMatch !== null) rootKey = inlineMatch[1]!
          }
          if (rootKey !== undefined && !defaultTableMigratorRoots.has(rootKey)) {
            defaultTableMigratorRoots.set(rootKey, relFilePath)
          }
        }
      }
    }

    const sqlRegex = /\bsql\s*`([\s\S]*?)`/g
    let sqlMatch: RegExpExecArray | null
    let reportedUnmanagedDdl = false
    while ((sqlMatch = sqlRegex.exec(noComments)) !== null) {
      const sqlBody = sqlMatch[1]!
      if (
        /\b(?:CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\b/i.test(
          sqlBody,
        )
      ) {
        const inside =
          hasMigratorImport &&
          allowedDdlSpans.some(([s, e]) => sqlMatch!.index > s && sqlMatch!.index < e)
        if (!inside && !reportedUnmanagedDdl) {
          reportedUnmanagedDdl = true
          findings.push({
            kind: "unmanaged-sql-ddl",
            nodeId: relFilePath,
            location: relFilePath,
            message: `Infrastructure module "${relFilePath}" executes raw SQL DDL without SqliteMigrator — manage Durable Object SQLite migrations via @effect/sql-sqlite-do/SqliteMigrator (SqliteMigrator.fromRecord) so applied versions are tracked in effect_sql_migrations (harness:ADR-0008, harness:SPEC-0006).`,
            action: `Wrap DDL statements in SqliteMigrator.fromRecord({ "1_init_...": ... }) and execute via SqliteMigrator.run or SqliteMigrator.layer.`,
          })
        }
        const safety = checkMigrationSqlSafety([{ file: relFilePath, sql: sqlBody }])
        for (const v of safety.violations) {
          findings.push({
            kind: "unsafe-sql-migration",
            nodeId: `${relFilePath}:${v.kind}`,
            location: relFilePath,
            message: v.message,
            action: `Escalate destructive migration (${v.kind}) to the human or refactor to an additive migration.`,
          })
        }
      }
    }

    const resolveRecordKeys = (initialBody: string, namedBodies: Map<string, string>) => {
      const visited = new Set<string>()
      const allKeys: Array<string> = []
      let hasUnresolvedSpread = false
      const collect = (body: string) => {
        const { keys, spreads } = extractTopLevelObjectAnalysis(body)
        for (const sp of spreads) {
          if (!visited.has(sp)) {
            visited.add(sp)
            const nb = namedBodies.get(sp) ?? packageNamedMigrationBodies.get(sp)
            if (nb !== undefined) collect(nb)
            else hasUnresolvedSpread = true
          }
        }
        for (const k of keys) allKeys.push(k)
      }
      collect(initialBody)
      return { keys: allKeys, hasUnresolvedSpread }
    }

    const reportedKeyNodeIds = new Set<string>()
    const astMigrator = analyzeSqliteMigratorFromRecordAst({
      filePath: relFilePath,
      content,
    })
    for (const issue of astMigrator.keyIssues) {
      const nodeId = `${relFilePath}:${issue.key}`
      if (!reportedKeyNodeIds.has(nodeId)) {
        reportedKeyNodeIds.add(nodeId)
        findings.push({
          kind: "invalid-migrator-record-key",
          nodeId,
          location: relFilePath,
          message: issue.message,
          action: `Rename migration key to "<positive_integer>_<snake_case_name>" (e.g. "1_init_tables") with an unused integer id.`,
        })
      }
    }
    const reportedUnsafeNodeIds = new Set<string>(findings.map((f) => `${f.kind}:${f.nodeId}`))
    for (const issue of astMigrator.unsafeSqlIssues) {
      const nodeId = `${relFilePath}:${issue.kind}`
      const dedupeKey = `unsafe-sql-migration:${nodeId}`
      if (!reportedUnsafeNodeIds.has(dedupeKey)) {
        reportedUnsafeNodeIds.add(dedupeKey)
        findings.push({
          kind: "unsafe-sql-migration",
          nodeId,
          location: relFilePath,
          message: issue.message,
          action: `Escalate destructive migration (${issue.kind}) to the human or refactor to an additive migration.`,
        })
      }
    }

    for (const objBody of [...fromRecordBodies, ...namedMigrationBodies.values()]) {
      const { keys, hasUnresolvedSpread } = resolveRecordKeys(objBody, namedMigrationBodies)
      const seenIds = new Set<number>()
      let hasFormatError = false
      for (const keyName of keys) {
        const m = /^([1-9]\d*)_([a-z0-9_]+)$/.exec(keyName)
        if (!m) {
          hasFormatError = true
          const nodeId = `${relFilePath}:${keyName}`
          if (!reportedKeyNodeIds.has(nodeId)) {
            reportedKeyNodeIds.add(nodeId)
            findings.push({
              kind: "invalid-migrator-record-key",
              nodeId,
              location: relFilePath,
              message: `Invalid SqliteMigrator.fromRecord migration key "${keyName}" in "${relFilePath}" — keys must match "<positive_integer>_<snake_case_name>" (e.g. "1_init_tables") because Effect Migrator.fromRecord silently ignores unnumbered keys (harness:ADR-0008, harness:SPEC-0006).`,
              action: `Rename migration key to "<positive_integer>_<snake_case_name>" (e.g. "1_init_tables") with an unused integer id.`,
            })
          }
        } else {
          const idNum = Number(m[1])
          if (seenIds.has(idNum)) {
            const nodeId = `${relFilePath}:${keyName}`
            if (!reportedKeyNodeIds.has(nodeId)) {
              reportedKeyNodeIds.add(nodeId)
              findings.push({
                kind: "invalid-migrator-record-key",
                nodeId,
                location: relFilePath,
                message: `Duplicate SqliteMigrator.fromRecord migration id "${m[1]}" in key "${keyName}" in "${relFilePath}".`,
                action: `Assign a unique positive integer id to migration key "${keyName}" in "${relFilePath}".`,
              })
            }
          } else seenIds.add(idNum)
        }
      }

      if (!hasUnresolvedSpread && !hasFormatError && seenIds.size > 0) {
        const sortedIds = [...seenIds].sort((a, b) => a - b)
        if (sortedIds[0]! !== 1) {
          const nodeId = `${relFilePath}:sequence-start-${String(sortedIds[0])}`
          if (!reportedKeyNodeIds.has(nodeId)) {
            reportedKeyNodeIds.add(nodeId)
            findings.push({
              kind: "invalid-migrator-record-key",
              nodeId,
              location: relFilePath,
              message: `SqliteMigrator.fromRecord migration sequence in "${relFilePath}" starts at id "${String(sortedIds[0])}" instead of "1" — each independent migrator sequence must start at "1_..." on its own migration table because Effect Migrator skips any migration id <= the highest applied id on a shared table (harness:ADR-0008, harness:SPEC-0006).`,
              action: `Start migration sequence at "1_<snake_case_name>" and configure a dedicated "table" option on SqliteMigrator.run / SqliteMigrator.layer when multiple migrators share a database.`,
            })
          }
        } else {
          for (let i = 1; i < sortedIds.length; i++) {
            if (sortedIds[i]! !== sortedIds[i - 1]! + 1) {
              const nodeId = `${relFilePath}:sequence-gap-${String(sortedIds[i - 1])}-${String(sortedIds[i])}`
              if (!reportedKeyNodeIds.has(nodeId)) {
                reportedKeyNodeIds.add(nodeId)
                findings.push({
                  kind: "invalid-migrator-record-key",
                  nodeId,
                  location: relFilePath,
                  message: `Non-contiguous SqliteMigrator.fromRecord migration sequence in "${relFilePath}" jumps from "${String(sortedIds[i - 1])}" to "${String(sortedIds[i])}".`,
                  action: `Ensure migration keys in "${relFilePath}" form a contiguous 1..N integer sequence.`,
                })
              }
            }
          }
        }
      }
    }
  }

  if (defaultTableMigratorRoots.size > 1) {
    const entries = [...defaultTableMigratorRoots.entries()]
    const allRootNames = entries.map(([name]) => name).join(", ")
    for (let idx = 1; idx < entries.length; idx++) {
      const [migratorId, relFilePath] = entries[idx]!
      findings.push({
        kind: "invalid-migrator-record-key",
        nodeId: `${relFilePath}:shared-default-migrations-table:${migratorId}`,
        location: relFilePath,
        message: `Multiple distinct SqliteMigrator loaders (${allRootNames}) in "${scope}/infra" use the default "effect_sql_migrations" table without a custom "table" option — Effect Migrator skips any migration id <= MAX(migration_id) on a shared table regardless of name (harness:ADR-0008, harness:SPEC-0006).`,
        action: `Pass a dedicated "table" option (e.g. table: "es_projector_sql_migrations") to SqliteMigrator.run and SqliteMigrator.layer for "${migratorId}".`,
      })
    }
  }
}
