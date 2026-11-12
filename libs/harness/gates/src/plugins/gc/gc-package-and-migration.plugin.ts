/**
 * Package Hygiene & SQL Migration Gate Plugin.
 *
 * Scans workspace package structure, dependencies, SQL DDL migrations,
 * SqliteMigrator configurations, and architecture policies.
 *
 * Rules owned:
 * - empty-source-module: Flags source files containing only empty exports.
 * - node-sqlite-in-infra: Banned node:sqlite imports in infra tiers.
 * - untrusted-row-brand-make: Flags unvalidated Brand.make calls on raw SQLite rows.
 * - unmanaged-sql-ddl: Flags raw DDL outside SqliteMigrator.fromRecord migrations.
 * - invalid-migrator-record-key: Enforces migration key format, ordering, and table names.
 * - unsafe-sql-migration: Flags destructive migration operations (DROP, ALTER without default).
 * - unused-package-dependency: Flags dependencies in package.json not imported in src/.
 * - architecture-policy-violation: Self-dogfooding and AST policy violations.
 * - unused-contract-export: Per-scope unused contract symbols.
 */
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs"
import { join, posix, relative } from "node:path"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { match } from "ts-pattern"
import * as Graph from "effect/Graph"
import { checkMigrationFiles, checkMigrationSqlSafety } from "../../migration-check.js"
import { AstSourceContent, AstSourceFilePath, decideAstGateCache, type AstGateFileInput } from "../../ast-cache.js"
import { evaluateAllGatePlugins, GatePluginRegistryLive } from "../gate-plugin-registry.js"
import { WorkspaceFsLive } from "../../services/workspace-fs.js"
import { WorkspaceFilePath } from "../self-dogfooding-contract.js"
import {
  collectModularPluginFiles,
  collectWorkspaceAllFiles,
  collectWorkspaceSqlFiles,
  collectWorkspaceTsFiles,
  extractBalancedBraces,
  extractBalancedParens,
  extractTopLevelObjectAnalysis,
  type GcFinding,
  type GraphEntropyInput,
  type GraphReachabilityContext,
  safeFs,
} from "./gc-helpers.js"
import { checkUnusedContractExports } from "./gc-topology-entropy.plugin.js"

const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const decodePackageJson = Schema.decodeUnknownOption(Schema.fromJsonString(PackageJsonSchema))

const SKIPPED_PACKAGE_DEPS = new Set([
  "effect", "@effect/sql-d1", "@effect/sql-sqlite-do", "@effect/ai-typesafe", "drizzle-orm",
])

const listSubdirs = (dir: string): ReadonlyArray<string> => {
  if (!existsSync(dir)) return []
  return safeFs<ReadonlyArray<string>>(
    () => {
      const dirents: ReadonlyArray<Dirent> = readdirSync(dir, { withFileTypes: true })
      return dirents.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b))
    },
    [],
  )
}

export const evaluatePackageAndMigrationPlugin = (
  input: GraphEntropyInput,
  _ctx?: GraphReachabilityContext,
): Effect.Effect<ReadonlyArray<GcFinding>> =>
  Effect.gen(function* () {
    if (input.workspaceRoot === undefined) return []
    const repoRoot = input.workspaceRoot
    const findings: Array<GcFinding> = []
    const libsDir = join(repoRoot, "libs")
    const scopes = listSubdirs(libsDir)

    for (const scope of scopes) {
      // Rule: unused-contract-export & dead-tagged-error (contract)
      findings.push(...checkUnusedContractExports(repoRoot, scope))

      const scopeDir = join(libsDir, scope)
      const tiers = listSubdirs(scopeDir)
      for (const tier of tiers) {
        const tierDir = join(scopeDir, tier)
        const srcDir = join(tierDir, "src")
        if (!existsSync(srcDir)) continue

        const srcFiles = collectWorkspaceTsFiles(srcDir).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"))
        const packageNamedMigrationBodies = new Map<string, string>()
        const defaultTableMigratorRoots = new Map<string, string>()

        if (tier === "infra" && scope !== "harness") {
          for (const file of srcFiles) {
            const content = safeFs(() => readFileSync(file, "utf8"), "")
            const noComments = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "")
            const mvRegex = /(?:const|let)\s+([A-Za-z0-9_$]*[Mm]igrations[A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{/g
            let mvMatch: RegExpExecArray | null
            while ((mvMatch = mvRegex.exec(noComments)) !== null) {
              const balanced = extractBalancedBraces(noComments, mvMatch.index + mvMatch[0].lastIndexOf("{"))
              if (balanced !== undefined) packageNamedMigrationBodies.set(mvMatch[1]!, balanced.body)
            }
          }
        }

        for (const file of srcFiles) {
          const relFilePath = relative(repoRoot, file).replace(/\\/g, "/")
          const content = safeFs(() => readFileSync(file, "utf8"), "")
          const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "").replace(/\s+/g, "")
          if (stripped === "" || stripped === "export{}" || stripped === "export{};") {
            findings.push({
              kind: "empty-source-module", nodeId: relFilePath, location: relFilePath,
              message: `Source module "${relFilePath}" contains only an empty export ('export {}') — remove dead placeholder modules or export concrete contracts.`,
              action: `Remove "${relFilePath}" or export concrete types/functions.`,
            })
          }

          if (tier === "infra" && scope !== "harness") {
            const noComments = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "")
            const nodeSqliteRegex = /\b(?:import\s*\(\s*|require\s*\(\s*|(?:import|from)\s+)["'](node:sqlite|sqlite|better-sqlite3)["']/g
            let sqliteMatch: RegExpExecArray | null
            while ((sqliteMatch = nodeSqliteRegex.exec(noComments)) !== null) {
              const mod = sqliteMatch[1]!
              findings.push({
                kind: "node-sqlite-in-infra", nodeId: `${relFilePath}:${mod}`, location: relFilePath,
                message: `Do not import '${mod}' in '${relFilePath}' — Cloudflare Durable Object SQLite and D1 storages in type:infra/type:app must execute against the real workerd runtime via @alchemy.run/cloudflare-runtime instead of hand-rolled node:sqlite mocks (harness:ADR-0008, harness:SPEC-0006).`,
                action: `Remove '${mod}' import and execute storage against @alchemy.run/cloudflare-runtime.`,
              })
            }

            const codeWithoutStrings = noComments.replace(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '""')
            const brandMakeRegex = /\b([A-Z][A-Za-z0-9_$]*)\.make\s*\(/g
            let bmMatch: RegExpExecArray | null
            const reportedBrandMakeIds = new Set<string>()
            while ((bmMatch = brandMakeRegex.exec(codeWithoutStrings)) !== null) {
              const brandName = bmMatch[1]!
              if (/^(?:ErrorMessage|Layer|Effect|Context|Option|Array|Set|Map|Record|LocalProjection|CrossAggregateProjection|EventBus|SqlSchema|Migrator|SqliteMigrator)$/.test(brandName)) continue
              const parenBalanced = extractBalancedParens(codeWithoutStrings, bmMatch.index + bmMatch[0].lastIndexOf("("))
              if (parenBalanced !== undefined) {
                const colMatch = /\b([A-Za-z_$][\w$]*\.[a-z]+_[a-z0-9_]+|(?:row|record|entry)\.[a-z][A-Za-z0-9_]*)\b(?!\s*\()/.exec(parenBalanced.body)
                if (colMatch !== null) {
                  const nodeId = `${relFilePath}:${brandName}.make(${colMatch[1]!})`
                  if (!reportedBrandMakeIds.has(nodeId)) {
                    reportedBrandMakeIds.add(nodeId)
                    findings.push({
                      kind: "untrusted-row-brand-make", nodeId, location: relFilePath,
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
            const mvRegex = /(?:const|let)\s+([A-Za-z0-9_$]*[Mm]igrations[A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*\{/g
            let mvMatch: RegExpExecArray | null
            while ((mvMatch = mvRegex.exec(noComments)) !== null) {
              const balanced = extractBalancedBraces(noComments, mvMatch.index + mvMatch[0].lastIndexOf("{"))
              if (balanced !== undefined) {
                namedMigrationBodies.set(mvMatch[1]!, balanced.body)
                if (hasMigratorImport) allowedDdlSpans.push([mvMatch.index + mvMatch[0].lastIndexOf("{"), balanced.endIndex])
              }
            }

            const fromRecordBodies: Array<string> = []
            const frRegex = /\bfromRecord\s*(?:<[^>]+>)?\s*\(\s*(\{|[A-Za-z_$][\w$]*)/g
            let frMatch: RegExpExecArray | null
            while ((frMatch = frRegex.exec(noComments)) !== null) {
              if (frMatch[1] === "{") {
                const balanced = extractBalancedBraces(noComments, frMatch.index + frMatch[0].lastIndexOf("{"))
                if (balanced !== undefined) {
                  fromRecordBodies.push(balanced.body)
                  if (hasMigratorImport) allowedDdlSpans.push([frMatch.index + frMatch[0].lastIndexOf("{"), balanced.endIndex])
                }
              } else fromRecordBodies.push(`...${frMatch[1]!}`)
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
                    if (new RegExp(`\\b${kv}\\b`).test(cfg.body)) { rootKey = kv; break }
                  }
                  if (rootKey === undefined) {
                    const inlineMatch = /["']([1-9]\d*_[a-z0-9_]+)["']\s*:/.exec(cfg.body)
                    if (inlineMatch !== null) rootKey = inlineMatch[1]!
                  }
                  if (rootKey !== undefined && !defaultTableMigratorRoots.has(rootKey)) defaultTableMigratorRoots.set(rootKey, relFilePath)
                }
              }
            }

            const sqlRegex = /\bsql\s*`([\s\S]*?)`/g
            let sqlMatch: RegExpExecArray | null, reportedUnmanagedDdl = false
            while ((sqlMatch = sqlRegex.exec(noComments)) !== null) {
              const sqlBody = sqlMatch[1]!
              if (/\b(?:CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|UNIQUE\s+INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\b/i.test(sqlBody)) {
                const inside = hasMigratorImport && allowedDdlSpans.some(([s, e]) => sqlMatch!.index >= s && sqlMatch!.index <= e)
                if (!inside && !reportedUnmanagedDdl) {
                  reportedUnmanagedDdl = true
                  findings.push({
                    kind: "unmanaged-sql-ddl", nodeId: relFilePath, location: relFilePath,
                    message: `Infrastructure module "${relFilePath}" executes raw SQL DDL without SqliteMigrator — manage Durable Object SQLite migrations via @effect/sql-sqlite-do/SqliteMigrator (SqliteMigrator.fromRecord) so applied versions are tracked in effect_sql_migrations (harness:ADR-0008, harness:SPEC-0006).`,
                    action: `Wrap DDL statements in SqliteMigrator.fromRecord({ "1_init_...": ... }) and execute via SqliteMigrator.run or SqliteMigrator.layer.`,
                  })
                }
                const safety = checkMigrationSqlSafety([{ file: relFilePath, sql: sqlBody }])
                for (const v of safety.violations) {
                  findings.push({
                    kind: "unsafe-sql-migration", nodeId: `${relFilePath}:${v.kind}`, location: relFilePath,
                    message: v.message,
                    action: `Escalate destructive migration (${v.kind}) to the human or refactor to an additive migration.`,
                  })
                }
              }
            }

            const resolveRecordKeys = (initialBody: string, namedBodies: Map<string, string>) => {
              const visited = new Set<string>(), allKeys: Array<string> = []
              let hasUnresolvedSpread = false
              const collect = (body: string) => {
                const { keys, spreads } = extractTopLevelObjectAnalysis(body)
                for (const sp of spreads) {
                  if (!visited.has(sp)) {
                    visited.add(sp)
                    const nb = namedBodies.get(sp) ?? packageNamedMigrationBodies.get(sp)
                    if (nb !== undefined) collect(nb); else hasUnresolvedSpread = true
                  }
                }
                for (const k of keys) allKeys.push(k)
              }
              collect(initialBody)
              return { keys: allKeys, hasUnresolvedSpread }
            }

            const reportedKeyNodeIds = new Set<string>()
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
                      kind: "invalid-migrator-record-key", nodeId, location: relFilePath,
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
                        kind: "invalid-migrator-record-key", nodeId, location: relFilePath,
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
                      kind: "invalid-migrator-record-key", nodeId, location: relFilePath,
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
                          kind: "invalid-migrator-record-key", nodeId, location: relFilePath,
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
        }

        if (tier === "infra" && scope !== "harness" && defaultTableMigratorRoots.size > 1) {
          const entries = [...defaultTableMigratorRoots.entries()]
          const allRootNames = entries.map(([name]) => name).join(", ")
          for (let idx = 1; idx < entries.length; idx++) {
            const [migratorId, relFilePath] = entries[idx]!
            findings.push({
              kind: "invalid-migrator-record-key", nodeId: `${relFilePath}:shared-default-migrations-table:${migratorId}`, location: relFilePath,
              message: `Multiple distinct SqliteMigrator loaders (${allRootNames}) in "${scope}/infra" use the default "effect_sql_migrations" table without a custom "table" option — Effect Migrator skips any migration id <= MAX(migration_id) on a shared table regardless of name (harness:ADR-0008, harness:SPEC-0006).`,
              action: `Pass a dedicated "table" option (e.g. table: "es_projector_sql_migrations") to SqliteMigrator.run and SqliteMigrator.layer for "${migratorId}".`,
            })
          }
        }

        const pkgJsonPath = join(tierDir, "package.json")
        const pkgContent = safeFs(() => existsSync(pkgJsonPath) ? readFileSync(pkgJsonPath, "utf8") : "", "")
        if (pkgContent.length > 0) {
          const pkgOpt = decodePackageJson(pkgContent)
          if (Option.isSome(pkgOpt) && pkgOpt.value.dependencies !== undefined) {
            const dependencies = pkgOpt.value.dependencies, pkgName = pkgOpt.value.name ?? `${scope}/${tier}`
            const scriptFiles = safeFs(() => existsSync(join(tierDir, "scripts")) ? collectWorkspaceAllFiles(join(tierDir, "scripts")) : [], [])
            const combinedContent = [...srcFiles, ...scriptFiles].map((f) => safeFs(() => readFileSync(f, "utf8"), "")).join("\n")
            for (const depName of Object.keys(dependencies)) {
              if (SKIPPED_PACKAGE_DEPS.has(depName)) continue
              const isReferenced = combinedContent.includes(`"${depName}"`) || combinedContent.includes(`'${depName}'`) || combinedContent.includes(`"${depName}/`) || combinedContent.includes(`'${depName}/`)
              if (!isReferenced) {
                const relPkgPath = relative(repoRoot, pkgJsonPath).replace(/\\/g, "/")
                findings.push({
                  kind: "unused-package-dependency", nodeId: `${pkgName}:${depName}`, location: relPkgPath,
                  message: `Package "${pkgName}" declares dependency "${depName}" in package.json, but no file in src/ imports it.`,
                  action: `Remove "${depName}" from dependencies in ${relPkgPath} or import it in src/.`,
                })
              }
            }
          }
        }
      }
    }

    const sqlFilesToScan: Array<string> = [...collectWorkspaceSqlFiles(join(repoRoot, "migrations"))]
    for (const scope of scopes) {
      const scopeDir = join(libsDir, scope)
      for (const tier of listSubdirs(scopeDir)) {
        sqlFilesToScan.push(...collectWorkspaceSqlFiles(join(scopeDir, tier, "migrations")))
      }
    }
    const appsDir = join(repoRoot, "apps")
    for (const app of listSubdirs(appsDir)) {
      sqlFilesToScan.push(...collectWorkspaceSqlFiles(join(appsDir, app, "migrations")))
    }
    if (sqlFilesToScan.length > 0) {
      for (const v of checkMigrationFiles(sqlFilesToScan).violations) {
        const relFile = relative(repoRoot, v.file).replace(/\\/g, "/")
        findings.push({
          kind: "unsafe-sql-migration", nodeId: `${relFile}:${v.kind}`, location: relFile,
          message: v.file !== relFile ? v.message.replaceAll(v.file, relFile) : v.message,
          action: `Escalate destructive migration (${v.kind}) to the human or refactor to an additive migration.`,
        })
      }
    }

    const modularFiles = collectModularPluginFiles(repoRoot)
    if (modularFiles.length > 0) {
      const gateExit = yield* evaluateAllGatePlugins({
        filePaths: modularFiles.map((f) => WorkspaceFilePath.make(f.replace(/\\/g, "/"))),
        failOnViolation: false,
      }).pipe(
        Effect.provide(Layer.mergeAll(GatePluginRegistryLive, WorkspaceFsLive)),
        Effect.exit,
      )
      match(gateExit)
        .with({ _tag: "Success" }, ({ value: gateReport }) => {
          for (const v of gateReport.violations) {
            const relFile = relative(repoRoot, v.file).replace(/\\/g, "/")
            findings.push({
              kind: "architecture-policy-violation", nodeId: `${relFile}:${v.rule}:${String(v.line)}`,
              location: `${relFile}:${String(v.line)}`, message: v.message,
              action: `Resolve self-dogfooding violation (${v.rule}) in ${relFile}:${String(v.line)}.`,
            })
          }
        })
        .with({ _tag: "Failure" }, (cause) => {
          findings.push({
            kind: "architecture-policy-violation", nodeId: "GatePluginRunner.evaluateAll",
            message: `Gate plugin evaluation failed: ${Cause.pretty(cause.cause)}`,
            action: "Investigate workspace file resolution and gate plugin execution failures.",
          })
        })
        .exhaustive()

      const astFiles: Array<AstGateFileInput> = []
      for (const f of modularFiles) {
        const content = safeFs(() => readFileSync(f, "utf8"), "")
        astFiles.push({
          filePath: AstSourceFilePath.make(relative(repoRoot, f).replace(/\\/g, "/")),
          content: AstSourceContent.make(content),
        })
      }
      if (astFiles.length > 0) {
        const astReport = yield* decideAstGateCache({ files: astFiles })
        for (const v of astReport.violations) {
          findings.push({
            kind: "architecture-policy-violation", nodeId: `${v.file}:${v.rule}:${String(v.line)}`,
            location: `${v.file}:${String(v.line)}`, message: v.message,
            action: `Resolve AST gate violation (${v.rule}) in ${v.file}:${String(v.line)}.`,
          })
        }
        const adj = new Map<string, Array<string>>()
        for (const af of astFiles) {
          const deps: Array<string> = []
          for (const m of af.content.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*from\s+)?["'](\.[^"']+)["']/g)) {
            if (m[1] !== undefined) deps.push(posix.normalize(posix.join(posix.dirname(af.filePath), m[1].replace(/\.js$/, ".ts"))))
          }
          adj.set(af.filePath, deps)
        }
        const state = new Map<string, number>()
        const visitCycle = (node: string, stack: Array<string>): void => {
          state.set(node, 1)
          for (const next of adj.get(node) ?? []) {
            const st = state.get(next) ?? 0
            if (st === 1) {
              const cyclePath = [...stack.slice(stack.indexOf(next)), next].join(" -> ")
              findings.push({
                kind: "architecture-policy-violation", nodeId: `${next}:circular-import`, location: next,
                message: `Circular relative import detected in modular harness files: ${cyclePath}`,
                action: `Break the circular import cycle (${cyclePath}) by extracting shared types/helpers into a leaf module.`,
              })
            } else if (st === 0 && adj.has(next)) visitCycle(next, [...stack, next])
          }
          state.set(node, 2)
        }
        for (const node of adj.keys()) { if ((state.get(node) ?? 0) === 0) visitCycle(node, [node]) }
      }
    }

    return findings
  })

export const scanPackageAndMigrationHygiene = (repoRoot: string): ReadonlyArray<GcFinding> =>
  Effect.runSync(
    evaluatePackageAndMigrationPlugin({
      graph: { graph: Graph.directed(), nodeIndexByKey: new Map() },
      workspaceRoot: repoRoot,
    }),
  )

export const scanWorkspacePackageHygiene = (repoRoot: string): ReadonlyArray<GcFinding> =>
  scanPackageAndMigrationHygiene(repoRoot)
