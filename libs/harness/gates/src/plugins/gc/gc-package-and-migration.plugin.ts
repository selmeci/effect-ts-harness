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
import { dirname, join, posix, relative } from "node:path"
import { Cause, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstSourceContent,
  AstSourceFilePath,
  NxTierTag,
  PackageDependencyName,
  PackageManifestName,
  PackageManifestPath,
  type PackageTierManifestInput,
  parseManifestTags,
  type ServiceTierSourceInput,
  toErrorReasonMessage,
  WorkspaceFileContent,
  WorkspaceFilePath,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import { WorkspaceFs } from "@harness/service"
import type { SyncHostIo } from "@harness/service/host-io"
import { checkMigrationFiles } from "../../migration-check.js"
import { decideAstGateCache, type AstGateFileInput } from "../../ast-cache.js"
import { evaluateAllGatePlugins, GatePluginRegistryLive } from "../gate-plugin-registry.js"
import {
  collectModularPluginFiles,
  collectWorkspaceAllFiles,
  collectWorkspaceSqlFiles,
  collectWorkspaceTsFiles,
  type GcFinding,
  type GraphEntropyInput,
  type GraphReachabilityContext,
  readdirOrReport,
  readTextOrReport,
} from "./gc-helpers.js"
import { checkUnusedContractExports } from "./gc-topology-entropy.plugin.js"
import { evaluateHookFastpathImportClosure } from "./gc-hook-fastpath.js"
import { evaluateInfraSqlAndSqliteHygiene } from "./gc-infra-sql-hygiene.js"
import { decideHarnessTierTopology } from "../harness-tier-topology.js"

const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nx: Schema.optional(
    Schema.Struct({
      tags: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
const decodePackageJson = Schema.decodeUnknownOption(Schema.fromJsonString(PackageJsonSchema))
const isBannedDrizzleDep = (d: string): boolean =>
  d === "drizzle-orm" ||
  d.startsWith("drizzle-orm/") ||
  d === "drizzle-kit" ||
  d.startsWith("drizzle-kit/")

const ProjectJsonSchema = Schema.Struct({
  tags: Schema.optional(Schema.Array(Schema.String)),
})
const decodeProjectJson = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectJsonSchema))

const SKIPPED_PACKAGE_DEPS = new Set([
  "effect",
  "@effect/sql-d1",
  "@effect/sql-sqlite-do",
  "@effect/ai-typesafe",
])

const listSubdirs = (
  dir: string,
  hostIo: SyncHostIo,
  repoRoot: string,
  findings: Array<GcFinding>,
): ReadonlyArray<string> => {
  if (!hostIo.existsSync(dir)) return []
  const entries = readdirOrReport(dir, hostIo, repoRoot, findings)
  if (entries === undefined) return []
  return entries
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

export const evaluatePackageAndMigrationPlugin = (
  input: GraphEntropyInput,
  _ctx?: GraphReachabilityContext,
): Effect.Effect<ReadonlyArray<GcFinding>> =>
  Effect.gen(function* () {
    if (input.workspaceRoot === undefined || input.hostIo === undefined) return []
    const repoRoot = input.workspaceRoot
    const hostIo = input.hostIo
    const workspaceFsImpl = {
      readTextFile: (filePath: WorkspaceFilePath) =>
        Effect.try({
          try: () => WorkspaceFileContent.make(hostIo.readTextSync(filePath)),
          catch: (err) =>
            new WorkspaceFsError({
              filePath,
              operation: WorkspaceFsOperation.make("read"),
              reason: toErrorReasonMessage(err, "Read failed"),
            }),
        }),
      writeTextFileAtomic: (filePath: WorkspaceFilePath, content: WorkspaceFileContent) =>
        Effect.suspend(() => {
          const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
          return Effect.try({
            try: () => {
              hostIo.mkdirRecursiveSync(dirname(filePath))
              hostIo.writeTextSync(tmpPath, content)
              hostIo.renameSync(tmpPath, filePath)
            },
            catch: (err) =>
              new WorkspaceFsError({
                filePath,
                operation: WorkspaceFsOperation.make("write"),
                reason: toErrorReasonMessage(err, "Write failed"),
              }),
          }).pipe(
            Effect.ensuring(
              Effect.ignore(
                Effect.try({
                  try: () => {
                    if (hostIo.existsSync(tmpPath)) {
                      hostIo.unlinkSync(tmpPath)
                    }
                  },
                  catch: () => undefined,
                }),
              ),
            ),
          )
        }),
      exists: (filePath: WorkspaceFilePath) => Effect.sync(() => hostIo.existsSync(filePath)),
      realPath: (filePath: WorkspaceFilePath) =>
        Effect.try({
          try: () => WorkspaceFilePath.make(hostIo.realpathSync(filePath)),
          catch: (err) =>
            new WorkspaceFsError({
              filePath,
              operation: WorkspaceFsOperation.make("stat"),
              reason: toErrorReasonMessage(err, "Realpath failed"),
            }),
        }),
    }
    const findings: Array<GcFinding> = []
    const tierManifests: Array<PackageTierManifestInput> = []
    const serviceTierFiles: Array<ServiceTierSourceInput> = []
    const workspaceSourceFiles: Array<ServiceTierSourceInput> = []
    const collectPackageManifest = (
      pkgDir: string,
      fallbackName: string,
      srcFiles: ReadonlyArray<string>,
      checkUnusedDeps: boolean,
    ): void => {
      const pkgJsonPath = join(pkgDir, "package.json")
      if (!hostIo.existsSync(pkgJsonPath)) return
      const relPkgPath = relative(repoRoot, pkgJsonPath).replace(/\\/g, "/")
      const pkgContent = readTextOrReport(pkgJsonPath, hostIo, repoRoot, findings)
      if (pkgContent === undefined) return
      const pkgOpt = decodePackageJson(pkgContent)
      const projectJsonPath = join(pkgDir, "project.json")
      const relProjPath = relative(repoRoot, projectJsonPath).replace(/\\/g, "/")
      const projectTags: Array<string> = []
      if (hostIo.existsSync(projectJsonPath)) {
        const projContent = readTextOrReport(projectJsonPath, hostIo, repoRoot, findings)
        if (projContent !== undefined) {
          const projOpt = decodeProjectJson(projContent)
          match(projOpt)
            .with({ _tag: "Some" }, ({ value: projValue }) => {
              for (const t of projValue.tags ?? []) {
                const trimmed = t.trim()
                if (trimmed.length > 0) projectTags.push(trimmed)
              }
            })
            .with({ _tag: "None" }, () => {
              findings.push({
                kind: "architecture-policy-violation",
                nodeId: `${relProjPath}:corrupt-manifest`,
                location: relProjPath,
                message: `Project manifest "${relProjPath}" is invalid JSON or failed schema validation.`,
                action: `Fix JSON syntax and schema in "${relProjPath}".`,
              })
            })
            .exhaustive()
        }
      }
      match(pkgOpt)
        .with({ _tag: "Some" }, ({ value: pkgValue }) => {
          const rawPkgName = pkgValue.name ?? fallbackName
          const pkgName = rawPkgName.trim()
          const mergedTagSet = new Set<string>([
            ...(pkgValue.nx?.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
            ...projectTags,
          ])
          const parsedTags = parseManifestTags(Array.from(mergedTagSet))
          const nxTags = [...parsedTags.nxTags]
          const scopeTags = [...parsedTags.scopeTags]
          const dependencyNames = [
            ...Object.keys(pkgValue.dependencies ?? {}),
            ...Object.keys(pkgValue.peerDependencies ?? {}),
            ...Object.keys(pkgValue.optionalDependencies ?? {}),
          ]
            .map((d) => d.trim())
            .filter((d) => d.length > 0)
            .map((d) => PackageDependencyName.make(d))
          const nonRuntimeDependencyNames = Object.keys(pkgValue.devDependencies ?? {})
            .map((d) => d.trim())
            .filter((d) => d.length > 0)
            .map((d) => PackageDependencyName.make(d))
          tierManifests.push({
            manifestPath: PackageManifestPath.make(relPkgPath),
            packageName: PackageManifestName.make(pkgName),
            nxTags,
            scopeTags,
            dependencyNames,
            nonRuntimeDependencyNames,
          })
          const isServiceTier = nxTags.includes(NxTierTag.make("type:service"))
          for (const file of srcFiles) {
            const content = readTextOrReport(file, hostIo, repoRoot, findings)
            if (content === undefined) continue
            const sourceInput: ServiceTierSourceInput = {
              filePath: AstSourceFilePath.make(relative(repoRoot, file).replace(/\\/g, "/")),
              content: AstSourceContent.make(content),
            }
            workspaceSourceFiles.push(sourceInput)
            if (isServiceTier) {
              serviceTierFiles.push(sourceInput)
            }
          }
          const testDir = join(pkgDir, "test")
          const scriptsDir = join(pkgDir, "scripts")
          const extraTierFiles = [
            ...(hostIo.existsSync(testDir)
              ? collectWorkspaceTsFiles(testDir, hostIo, findings, repoRoot)
              : []),
            ...(hostIo.existsSync(scriptsDir)
              ? collectWorkspaceTsFiles(scriptsDir, hostIo, findings, repoRoot)
              : []),
          ]
          const isContractTier = nxTags.includes(NxTierTag.make("type:contract"))
          for (const file of extraTierFiles) {
            const content = readTextOrReport(file, hostIo, repoRoot, findings)
            if (content === undefined) continue
            const relExtraPath = relative(repoRoot, file).replace(/\\/g, "/")
            if (isContractTier && /["'`]@effect\/vitest(?:\/[^"'`]*)?["'`]/.test(content)) {
              findings.push({
                kind: "contract-test-effect-vitest-import",
                nodeId: `${relExtraPath}:@effect/vitest`,
                location: relExtraPath,
                message: `Contract test file "${relExtraPath}" (${pkgName}, type:contract) imports "@effect/vitest" — type:contract tests must import { describe, expect, it } from "vitest".`,
                action: `Replace "@effect/vitest" with "vitest" in "${relExtraPath}".`,
              })
            }
            workspaceSourceFiles.push({
              filePath: AstSourceFilePath.make(relExtraPath),
              content: AstSourceContent.make(content),
            })
          }
          if (checkUnusedDeps && pkgValue.dependencies !== undefined) {
            const dependencies = pkgValue.dependencies
            const scriptFiles = hostIo.existsSync(scriptsDir)
              ? collectWorkspaceAllFiles(scriptsDir, hostIo, findings, repoRoot)
              : []
            const combinedContent = [...srcFiles, ...scriptFiles]
              .map((f) => readTextOrReport(f, hostIo, repoRoot, findings) ?? "")
              .join("\n")
            for (const depName of Object.keys(dependencies)) {
              if (SKIPPED_PACKAGE_DEPS.has(depName)) continue
              const isReferenced =
                combinedContent.includes(`"${depName}"`) ||
                combinedContent.includes(`'${depName}'`) ||
                combinedContent.includes(`"${depName}/`) ||
                combinedContent.includes(`'${depName}/`)
              if (!isReferenced) {
                findings.push({
                  kind: "unused-package-dependency",
                  nodeId: `${rawPkgName}:${depName}`,
                  location: relPkgPath,
                  message: `Package "${rawPkgName}" declares dependency "${depName}" in package.json, but no file in src/ imports it.`,
                  action: `Remove "${depName}" from dependencies in ${relPkgPath} or import it in src/.`,
                })
              }
            }
          }
        })
        .with({ _tag: "None" }, () => {
          findings.push({
            kind: "architecture-policy-violation",
            nodeId: `${relPkgPath}:corrupt-manifest`,
            location: relPkgPath,
            message: `Package manifest "${relPkgPath}" is invalid JSON or failed schema validation.`,
            action: `Fix JSON syntax and schema in "${relPkgPath}".`,
          })
        })
        .exhaustive()
    }

    const libsDir = join(repoRoot, "libs")
    const scopes = listSubdirs(libsDir, hostIo, repoRoot, findings)

    for (const scope of scopes) {
      // Rule: unused-contract-export & dead-tagged-error (contract)
      findings.push(...checkUnusedContractExports(repoRoot, hostIo, scope))

      const scopeDir = join(libsDir, scope)
      const tiers = listSubdirs(scopeDir, hostIo, repoRoot, findings)
      for (const tier of tiers) {
        const tierDir = join(scopeDir, tier)
        const srcDir = join(tierDir, "src")
        if (!hostIo.existsSync(srcDir)) continue

        const srcFiles = collectWorkspaceTsFiles(srcDir, hostIo, findings, repoRoot).filter(
          (f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"),
        )

        for (const file of srcFiles) {
          const relFilePath = relative(repoRoot, file).replace(/\\/g, "/")
          const content = readTextOrReport(file, hostIo, repoRoot, findings)
          if (content === undefined) continue
          const stripped = content
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\r\n]*/g, "")
            .replace(/\s+/g, "")
          if (stripped === "" || stripped === "export{}" || stripped === "export{};") {
            findings.push({
              kind: "empty-source-module",
              nodeId: relFilePath,
              location: relFilePath,
              message: `Source module "${relFilePath}" contains only an empty export ('export {}') — remove dead placeholder modules or export concrete contracts.`,
              action: `Remove "${relFilePath}" or export concrete types/functions.`,
            })
          }
        }

        if (tier === "infra" && scope !== "harness") {
          evaluateInfraSqlAndSqliteHygiene(repoRoot, scope, srcFiles, hostIo, findings)
        }

        if (tier === "infra" && scope !== "harness") {
          const migrationsDir = join(tierDir, "migrations")
          const infraTestDir = join(tierDir, "test")
          if (
            hostIo.existsSync(migrationsDir) &&
            hostIo.existsSync(infraTestDir) &&
            collectWorkspaceSqlFiles(migrationsDir, hostIo, findings, repoRoot).length > 0
          ) {
            for (const testFile of collectWorkspaceTsFiles(
              infraTestDir,
              hostIo,
              findings,
              repoRoot,
            )) {
              const testContent = readTextOrReport(testFile, hostIo, repoRoot, findings)
              if (testContent === undefined) continue
              if (
                /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\b/i.test(testContent) &&
                !testContent.includes("migrations/") &&
                !testContent.includes("SqliteMigrator")
              ) {
                const relTestFile = relative(repoRoot, testFile).replace(/\\/g, "/")
                findings.push({
                  kind: "inline-test-ddl-bypassing-migrations",
                  nodeId: relTestFile,
                  location: relTestFile,
                  message: `Infra test "${relTestFile}" defines inline CREATE TABLE SQL while "${scope}/infra/migrations/" has .sql migrations — run real migrations from migrations/ or SqliteMigrator instead of drifting inline test schemas.`,
                  action: `Load SQL migrations from "${scope}/infra/migrations/" or SqliteMigrator in "${relTestFile}".`,
                })
              }
            }
          }
        }

        collectPackageManifest(tierDir, `${scope}/${tier}`, srcFiles, true)
      }
    }

    const appsDir = join(repoRoot, "apps")
    for (const app of listSubdirs(appsDir, hostIo, repoRoot, findings)) {
      const appDir = join(appsDir, app)
      const appSrcDir = join(appDir, "src")
      const appSrcFiles = hostIo.existsSync(appSrcDir)
        ? collectWorkspaceTsFiles(appSrcDir, hostIo, findings, repoRoot).filter(
            (f) => !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"),
          )
        : []
      collectPackageManifest(appDir, app, appSrcFiles, false)
    }

    const rootPkgJsonPath = join(repoRoot, "package.json")
    if (hostIo.existsSync(rootPkgJsonPath)) {
      const rootContent = readTextOrReport(rootPkgJsonPath, hostIo, repoRoot, findings)
      if (rootContent !== undefined) {
        const rootOpt = decodePackageJson(rootContent)
        match(rootOpt)
          .with({ _tag: "Some" }, ({ value: rootPkg }) => {
            const allRootDeps = [
              ...Object.keys(rootPkg.dependencies ?? {}),
              ...Object.keys(rootPkg.devDependencies ?? {}),
              ...Object.keys(rootPkg.peerDependencies ?? {}),
              ...Object.keys(rootPkg.optionalDependencies ?? {}),
            ]
              .map((d) => d.trim())
              .filter((d) => d.length > 0)
            for (const dep of allRootDeps) {
              if (isBannedDrizzleDep(dep)) {
                findings.push({
                  kind: "architecture-policy-violation",
                  nodeId: `package.json:forbidden-core-dependency:${dep}`,
                  location: "package.json",
                  message: `Root package "${(rootPkg.name ?? "root").trim()}" declares banned Drizzle dependency "${dep}" in "package.json" — use native Effect v4 SQL (@effect/sql-d1, @effect/sql-sqlite-do, SqlClient, SqliteMigrator).`,
                  action: `Remove "${dep}" from package.json.`,
                })
              }
            }
          })
          .with({ _tag: "None" }, () => {
            findings.push({
              kind: "architecture-policy-violation",
              nodeId: "package.json:corrupt-manifest",
              location: "package.json",
              message: `Package manifest "package.json" is invalid JSON or failed schema validation.`,
              action: `Fix JSON syntax and schema in "package.json".`,
            })
          })
          .exhaustive()
      }
    }

    if (tierManifests.length > 0 || serviceTierFiles.length > 0) {
      const tierReport = yield* decideHarnessTierTopology({
        manifests: tierManifests,
        serviceFiles: serviceTierFiles,
        workspaceSourceFiles,
      })
      for (const v of tierReport.violations) {
        findings.push({
          kind: "architecture-policy-violation",
          nodeId: `${v.location}:${v.rule}`,
          location: v.location,
          message: v.message,
          action: `Resolve hexagonal tier topology violation (${v.rule}) in ${v.location}.`,
        })
      }
    }

    const sqlFilesToScan: Array<string> = [
      ...collectWorkspaceSqlFiles(join(repoRoot, "migrations"), hostIo, findings, repoRoot),
    ]
    for (const scope of scopes) {
      const scopeDir = join(libsDir, scope)
      for (const tier of listSubdirs(scopeDir, hostIo, repoRoot, findings)) {
        sqlFilesToScan.push(
          ...collectWorkspaceSqlFiles(
            join(scopeDir, tier, "migrations"),
            hostIo,
            findings,
            repoRoot,
          ),
        )
      }
    }
    for (const app of listSubdirs(appsDir, hostIo, repoRoot, findings)) {
      sqlFilesToScan.push(
        ...collectWorkspaceSqlFiles(join(appsDir, app, "migrations"), hostIo, findings, repoRoot),
      )
    }
    if (sqlFilesToScan.length > 0) {
      for (const v of checkMigrationFiles(sqlFilesToScan, hostIo).violations) {
        const relFile = relative(repoRoot, v.file).replace(/\\/g, "/")
        findings.push({
          kind: "unsafe-sql-migration",
          nodeId: `${relFile}:${v.kind}`,
          location: relFile,
          message: v.file !== relFile ? v.message.replaceAll(v.file, relFile) : v.message,
          action: `Escalate destructive migration (${v.kind}) to the human or refactor to an additive migration.`,
        })
      }
    }

    const modularFiles = collectModularPluginFiles(repoRoot, hostIo, findings)
    if (modularFiles.length > 0) {
      const gateExit = yield* evaluateAllGatePlugins({
        filePaths: modularFiles.map((f) => WorkspaceFilePath.make(f.replace(/\\/g, "/"))),
        failOnViolation: false,
      }).pipe(
        Effect.provideService(WorkspaceFs, workspaceFsImpl),
        Effect.provide(GatePluginRegistryLive),
        Effect.exit,
      )
      match(gateExit)
        .with({ _tag: "Success" }, ({ value: gateReport }) => {
          for (const v of gateReport.violations) {
            const relFile = relative(repoRoot, v.file).replace(/\\/g, "/")
            findings.push({
              kind: "architecture-policy-violation",
              nodeId: `${relFile}:${v.rule}:${String(v.line)}`,
              location: `${relFile}:${String(v.line)}`,
              message: v.message,
              action: `Resolve self-dogfooding violation (${v.rule}) in ${relFile}:${String(v.line)}.`,
            })
          }
        })
        .with({ _tag: "Failure" }, (cause) => {
          findings.push({
            kind: "architecture-policy-violation",
            nodeId: "GatePluginRunner.evaluateAll",
            message: `Gate plugin evaluation failed: ${Cause.pretty(cause.cause)}`,
            action: "Investigate workspace file resolution and gate plugin execution failures.",
          })
        })
        .exhaustive()

      const astFiles: Array<AstGateFileInput> = []
      for (const f of modularFiles) {
        const content = readTextOrReport(f, hostIo, repoRoot, findings)
        if (content === undefined) continue
        astFiles.push({
          filePath: AstSourceFilePath.make(relative(repoRoot, f).replace(/\\/g, "/")),
          content: AstSourceContent.make(content),
        })
      }
      if (astFiles.length > 0) {
        const astReport = yield* decideAstGateCache({ files: astFiles })
        for (const v of astReport.violations) {
          findings.push({
            kind: "architecture-policy-violation",
            nodeId: `${v.file}:${v.rule}:${String(v.line)}`,
            location: `${v.file}:${String(v.line)}`,
            message: v.message,
            action: `Resolve AST gate violation (${v.rule}) in ${v.file}:${String(v.line)}.`,
          })
        }
        const adj = new Map<string, Array<string>>()
        for (const af of astFiles) {
          const deps: Array<string> = []
          for (const m of af.content.matchAll(
            /(?:import|export)\s+(?:type\s+)?(?:[^"']*from\s+)?["'](\.[^"']+)["']/g,
          )) {
            if (m[1] !== undefined)
              deps.push(
                posix.normalize(
                  posix.join(posix.dirname(af.filePath), m[1].replace(/\.js$/, ".ts")),
                ),
              )
          }
          adj.set(af.filePath, deps)
        }
        const state = new Map<string, number>()
        const visitCycle = (node: string, stack: Array<string>): void => {
          state.set(node, 1)
          for (const next of adj.get(node) ?? []) {
            const st = state.get(next) ?? 0
            match<number>(st)
              .with(1, () => {
                const cyclePath = [...stack.slice(stack.indexOf(next)), next].join(" -> ")
                findings.push({
                  kind: "architecture-policy-violation",
                  nodeId: `${next}:circular-import`,
                  location: next,
                  message: `Circular relative import detected in modular harness files: ${cyclePath}`,
                  action: `Break the circular import cycle (${cyclePath}) by extracting shared types/helpers into a leaf module.`,
                })
              })
              .with(0, () => {
                if (adj.has(next)) visitCycle(next, [...stack, next])
              })
              .otherwise(() => {})
          }
          state.set(node, 2)
        }
        for (const node of adj.keys()) {
          if ((state.get(node) ?? 0) === 0) visitCycle(node, [node])
        }
      }
      evaluateHookFastpathImportClosure(repoRoot, hostIo, findings)
    }

    return findings
  })
