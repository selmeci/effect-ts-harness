import { describe, expect, it } from "@effect/vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { buildHarnessGraph, loadGraphSnapshot } from "@harness/graph"
import {
  buildSessionHandoff,
  checkLoopThrashing,
  checkMigrationSqlSafety,
  checkSpanBudgets,
  classifyFileWrite,
  decideAdrDocQuality,
  decideEarsSpecQuality,
  decideGraphEntropy,
  decideLoopThrashing,
  decideMigrationSafety,
  decideMutationReport,
  decideSessionHandoff,
  decideSpanBudgets,
  diffPlanAndImplGraphs,
  discoverDomainMutants,
  evaluateMutationOutcomes,
  lintAdrDocMarkdown,
  lintEarsSpecMarkdown,
  loadGovernanceDocsFromDisk,
  parseGovernanceDocFrontmatter,
  resolveHarnessStateDir,
  scanGraphEntropy,
  type CodeMutant,
  type FrictionCluster,
  type FrictionEvent,
  type GovernanceDocReference,
  type SpanSample
} from "../src/index.js"

describe("Harness Gates: GC check, Session Handoff, Span Budget, and State Dir", () => {
  it("diffs plan and impl snapshots and confirms 0 missing symbols", () => {
    const repoRoot = "/home/roan/WebstormProjects/effect-ts-harness"
    const planPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
    const implPath = join(repoRoot, ".harness", "graph-snapshot.json")
    if (existsSync(planPath) && existsSync(implPath)) {
      const planGraph = loadGraphSnapshot(planPath)
      const implGraph = loadGraphSnapshot(implPath)
      const diff = diffPlanAndImplGraphs(planGraph, implGraph)
      expect(diff.ok).toBe(true)
      expect(diff.reasons).toHaveLength(0)
    }
  })
  describe("decideGraphEntropy / scanGraphEntropy", () => {
    it.effect("detects unused-service, unprovided-service, dead-tagged-error, and missing-pattern-doc", () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          services: [
            {
              tagId: "UnusedAndUnprovided",
              name: "UnusedAndUnprovided",
              packageTag: "service",
              file: "libs/sample/service/src/index.ts"
            },
            // Built-in framework services should be ignored
            {
              tagId: "DecisionModel",
              name: "DecisionModel",
              packageTag: "service",
              file: "libs/harness/decision/src/index.ts"
            },
            {
              tagId: "@harness/ingest/SpanRecorder",
              name: "SpanRecorder",
              packageTag: "service",
              file: "libs/harness/ingest/src/index.ts"
            }
          ],
          errors: [
            {
              errorTag: "DeadCustomError",
              file: "libs/sample/contract/src/index.ts"
            },
            // Built-in framework errors should be ignored
            {
              errorTag: "OmnigraphLoadError",
              file: "libs/harness/graph/src/index.ts"
            },
            {
              errorTag: "SchemaError",
              file: "libs/harness/graph/src/index.ts"
            }
          ]
        })

        const report = yield* decideGraphEntropy({
          graph,
          expectedPatterns: ["planning", "httpapi", "review", "effect"]
        })

        expect(report.clean).toBe(false)

        const kinds = report.findings.map((f) => f.kind)
        expect(kinds).toContain("unused-service")
        expect(kinds).toContain("unprovided-service")
        expect(kinds).toContain("dead-tagged-error")
        expect(kinds).toContain("missing-pattern-doc")

        // Unused & unprovided for UnusedAndUnprovided
        const unused = report.findings.find(
          (f) => f.kind === "unused-service" && f.nodeId === "UnusedAndUnprovided"
        )
        expect(unused).toBeDefined()
        expect(unused?.message).toContain("has no consumers")

        const unprovided = report.findings.find(
          (f) => f.kind === "unprovided-service" && f.nodeId === "UnusedAndUnprovided"
        )
        expect(unprovided).toBeDefined()
        expect(unprovided?.message).toContain("has no providing ServiceLayer")

        // Ignored services should NOT produce findings
        expect(
          report.findings.some(
            (f) => f.nodeId === "DecisionModel" || f.nodeId === "@harness/ingest/SpanRecorder"
          )
        ).toBe(false)

        // Dead tagged error
        const deadErr = report.findings.find(
          (f) => f.kind === "dead-tagged-error" && f.nodeId === "DeadCustomError"
        )
        expect(deadErr).toBeDefined()
        expect(deadErr?.message).toContain("is never emitted in any E channel")

        // Ignored errors should NOT produce findings
        expect(
          report.findings.some(
            (f) => f.nodeId === "OmnigraphLoadError" || f.nodeId === "SchemaError"
          )
        ).toBe(false)

        // Missing pattern docs for planning and httpapi (review & effect excluded)
        const missingDocs = report.findings.filter((f) => f.kind === "missing-pattern-doc")
        expect(missingDocs.map((f) => f.nodeId)).toEqual(["Pattern:planning", "Pattern:httpapi"])
      })
    )

    it("passes clean: true via scanGraphEntropy when all elements are correctly wired", () => {
      const graph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#greet",
            spanName: "Sample.greet",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 5,
            successType: "string",
            isStub: false
          }
        ],
        services: [
          {
            tagId: "GreeterService",
            name: "GreeterService",
            packageTag: "service",
            file: "libs/sample/service/src/index.ts"
          }
        ],
        layers: [
          {
            qualname: "libs/sample/infra/src/index.ts#GreeterLive",
            layerKind: "live",
            packageTag: "infra",
            file: "libs/sample/infra/src/index.ts"
          }
        ],
        errors: [
          {
            errorTag: "GreeterError",
            file: "libs/sample/contract/src/index.ts"
          }
        ],
        patternDocs: [
          {
            slug: "planning",
            path: "agent-patterns/planning.md",
            summary: "Planning pattern"
          }
        ],
        requiresService: [
          {
            callerQualname: "libs/sample/domain/src/index.ts#greet",
            tagId: "GreeterService"
          }
        ],
        providesService: [
          {
            layerQualname: "libs/sample/infra/src/index.ts#GreeterLive",
            tagId: "GreeterService"
          }
        ],
        failsWith: [
          {
            callerQualname: "libs/sample/domain/src/index.ts#greet",
            errorTag: "GreeterError"
          }
        ]
      })

      const report = scanGraphEntropy(graph, {
        expectedPatterns: ["planning", "review", "effect"]
      })

      expect(report.clean).toBe(true)
      expect(report.findings).toHaveLength(0)
    })

    it.effect("flags untested domain EffectFn when checkUntestedDomainFns: true, passes once tested", () =>
      Effect.gen(function* () {
        const fnNode = {
          qualname: "libs/sample/domain/src/index.ts#greet",
          spanName: "Sample.greet",
          packageTag: "domain" as const,
          file: "libs/sample/domain/src/index.ts",
          line: 9,
          successType: "string",
          isStub: false
        }

        const graphWithoutTest = buildHarnessGraph({
          fns: [fnNode]
        })

        const reportUntested = yield* decideGraphEntropy({
          graph: graphWithoutTest,
          checkUntestedDomainFns: true
        })

        expect(reportUntested.clean).toBe(false)
        const untested = reportUntested.findings.find((f) => f.kind === "untested-effect-fn")
        expect(untested).toBeDefined()
        expect(untested?.nodeId).toBe("Sample.greet")
        expect(untested?.message).toContain("has 0 reaching tests")

        // Now add a VitestCase and ExercisesSpan edge
        const graphWithTest = buildHarnessGraph({
          fns: [fnNode],
          tests: [
            {
              testId: "libs/sample/domain/test/index.test.ts::suite",
              testFile: "libs/sample/domain/test/index.test.ts",
              testName: "libs/sample/domain/test/index.test.ts",
              lastTreeHash: "workspace"
            }
          ],
          exercisesSpans: [
            {
              testId: "libs/sample/domain/test/index.test.ts::suite",
              calleeQualname: "libs/sample/domain/src/index.ts#greet",
              callCount: 1,
              receiverLayer: null
            }
          ]
        })

        const reportTested = yield* decideGraphEntropy({
          graph: graphWithTest,
          checkUntestedDomainFns: true
        })

        const untestedAfter = reportTested.findings.filter((f) => f.kind === "untested-effect-fn")
        expect(untestedAfter).toHaveLength(0)
        expect(reportTested.clean).toBe(true)
      })
    )

    it("parses ADR and EARS spec YAML frontmatter accurately", () => {
      const adrMarkdown = `---
id: ADR-0001
status: accepted
enforced_by:
  - libs/harness/gates/src/gc-check.ts
  - libs/harness/gates/test/gc-handoff-budget.test.ts
spans:
  - Sample.greet
services:
  - GreeterService
errors:
  - GreeterError
---
# ADR-0001
`
      const parsedAdr = parseGovernanceDocFrontmatter(
        "docs/adr/0001-adr.md",
        adrMarkdown,
        (rel) => rel.includes("gc-check.ts")
      )
      expect(parsedAdr).not.toBeNull()
      expect(parsedAdr?.id).toBe("ADR-0001")
      expect(parsedAdr?.status).toBe("accepted")
      expect(parsedAdr?.docPath).toBe("docs/adr/0001-adr.md")
      expect(parsedAdr?.enforcedByFiles).toEqual([
        "libs/harness/gates/src/gc-check.ts",
        "libs/harness/gates/test/gc-handoff-budget.test.ts"
      ])
      expect(parsedAdr?.existingFiles).toEqual([
        "libs/harness/gates/src/gc-check.ts"
      ])
      expect(parsedAdr?.referencedSpans).toEqual(["Sample.greet"])
      expect(parsedAdr?.referencedServices).toEqual(["GreeterService"])
      expect(parsedAdr?.referencedErrors).toEqual(["GreeterError"])

      // Test inline lists and default proposed status
      const earsMarkdown = `---
id: "SPEC-0001"
enforced_by: ["libs/sample/domain/src/index.ts"]
spans: ["Sample.greet", 'Sample.farewell']
services: [GreeterService]
errors: []
---
# EARS Spec
`
      const parsedEars = parseGovernanceDocFrontmatter(
        "docs/specs/0001-spec.md",
        earsMarkdown
      )
      expect(parsedEars).not.toBeNull()
      expect(parsedEars?.id).toBe("SPEC-0001")
      expect(parsedEars?.status).toBe("proposed")
      expect(parsedEars?.enforcedByFiles).toEqual(["libs/sample/domain/src/index.ts"])
      expect(parsedEars?.existingFiles).toEqual(["libs/sample/domain/src/index.ts"])
      expect(parsedEars?.referencedSpans).toEqual(["Sample.greet", "Sample.farewell"])
      expect(parsedEars?.referencedServices).toEqual(["GreeterService"])
      expect(parsedEars?.referencedErrors).toEqual([])

      // Missing or invalid frontmatter/id
      expect(parseGovernanceDocFrontmatter("docs/adr/no-fm.md", "# Just MD")).toBeNull()
      expect(
        parseGovernanceDocFrontmatter("docs/adr/no-id.md", "---\nstatus: accepted\n---")
      ).toBeNull()
      expect(
        parseGovernanceDocFrontmatter("docs/adr/empty-id.md", "---\nid: ''\n---")
      ).toBeNull()
    })

    it("returns clean: true when accepted ADR/Spec references valid files, spans, services, and errors", () => {
      const graph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/index.ts#greet",
            spanName: "Sample.greet",
            packageTag: "domain",
            file: "libs/sample/domain/src/index.ts",
            line: 5,
            successType: "string",
            isStub: false
          }
        ],
        services: [
          {
            tagId: "GreeterService",
            name: "GreeterService",
            packageTag: "service",
            file: "libs/sample/service/src/index.ts"
          }
        ],
        layers: [
          {
            qualname: "libs/sample/infra/src/index.ts#GreeterLive",
            layerKind: "live",
            packageTag: "infra",
            file: "libs/sample/infra/src/index.ts"
          }
        ],
        errors: [
          {
            errorTag: "GreeterError",
            file: "libs/sample/contract/src/index.ts"
          }
        ],
        patternDocs: [
          {
            slug: "planning",
            path: "agent-patterns/planning.md",
            summary: "Planning pattern"
          }
        ],
        requiresService: [
          {
            callerQualname: "libs/sample/domain/src/index.ts#greet",
            tagId: "GreeterService"
          }
        ],
        providesService: [
          {
            layerQualname: "libs/sample/infra/src/index.ts#GreeterLive",
            tagId: "GreeterService"
          }
        ],
        failsWith: [
          {
            callerQualname: "libs/sample/domain/src/index.ts#greet",
            errorTag: "GreeterError"
          }
        ]
      })

      const doc: GovernanceDocReference = {
        docPath: "docs/adr/0001-greeter.md",
        id: "ADR-0001",
        status: "accepted",
        enforcedByFiles: ["libs/sample/domain/src/index.ts"],
        existingFiles: ["libs/sample/domain/src/index.ts"],
        referencedSpans: ["Sample.greet"],
        referencedServices: ["GreeterService"],
        referencedErrors: ["GreeterError"]
      }

      const report = scanGraphEntropy(graph, {
        expectedPatterns: ["planning", "review", "effect"],
        governanceDocs: [doc]
      })

      expect(report.clean).toBe(true)
      expect(report.findings).toHaveLength(0)
    })

    it.effect("flags stale-doc-reference when accepted doc references missing elements while ignoring proposed/superseded", () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/index.ts#greet",
              spanName: "Sample.greet",
              packageTag: "domain",
              file: "libs/sample/domain/src/index.ts",
              line: 5,
              successType: "string",
              isStub: false
            }
          ],
          services: [
            {
              tagId: "GreeterService",
              name: "GreeterService",
              packageTag: "service",
              file: "libs/sample/service/src/index.ts"
            }
          ],
          layers: [
            {
              qualname: "libs/sample/infra/src/index.ts#GreeterLive",
              layerKind: "live",
              packageTag: "infra",
              file: "libs/sample/infra/src/index.ts"
            }
          ],
          errors: [
            {
              errorTag: "GreeterError",
              file: "libs/sample/contract/src/index.ts"
            }
          ],
          patternDocs: [
            {
              slug: "planning",
              path: "agent-patterns/planning.md",
              summary: "Planning pattern"
            }
          ],
          requiresService: [
            {
              callerQualname: "libs/sample/domain/src/index.ts#greet",
              tagId: "GreeterService"
            }
          ],
          providesService: [
            {
              layerQualname: "libs/sample/infra/src/index.ts#GreeterLive",
              tagId: "GreeterService"
            }
          ],
          failsWith: [
            {
              callerQualname: "libs/sample/domain/src/index.ts#greet",
              errorTag: "GreeterError"
            }
          ]
        })

        const staleAcceptedDoc: GovernanceDocReference = {
          docPath: "docs/adr/0002-stale.md",
          id: "ADR-0002",
          status: "accepted",
          enforcedByFiles: ["libs/sample/deleted.ts"],
          existingFiles: [],
          referencedSpans: ["Missing.span"],
          referencedServices: ["MissingService"],
          referencedErrors: ["MissingError"]
        }

        const proposedDocWithBrokenRefs: GovernanceDocReference = {
          docPath: "docs/specs/0001-draft.md",
          id: "SPEC-0001",
          status: "proposed",
          enforcedByFiles: ["libs/sample/draft-nonexistent.ts"],
          existingFiles: [],
          referencedSpans: ["Draft.span"],
          referencedServices: ["DraftService"],
          referencedErrors: ["DraftError"]
        }

        const supersededDocWithBrokenRefs: GovernanceDocReference = {
          docPath: "docs/adr/0000-old.md",
          id: "ADR-0000",
          status: "superseded",
          enforcedByFiles: ["libs/sample/old-nonexistent.ts"],
          existingFiles: [],
          referencedSpans: ["Old.span"],
          referencedServices: ["OldService"],
          referencedErrors: ["OldError"]
        }

        const report = yield* decideGraphEntropy({
          graph,
          expectedPatterns: ["planning", "review", "effect"],
          governanceDocs: [
            staleAcceptedDoc,
            proposedDocWithBrokenRefs,
            supersededDocWithBrokenRefs
          ]
        })

        expect(report.clean).toBe(false)
        const staleFindings = report.findings.filter((f) => f.kind === "stale-doc-reference")
        expect(staleFindings).toHaveLength(4)

        const fileFinding = staleFindings.find(
          (f) => f.nodeId === "ADR-0002:libs/sample/deleted.ts"
        )
        expect(fileFinding).toBeDefined()
        expect(fileFinding?.message).toContain(
          'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent enforced_by file "libs/sample/deleted.ts".'
        )

        const spanFinding = staleFindings.find((f) => f.nodeId === "ADR-0002:Missing.span")
        expect(spanFinding).toBeDefined()
        expect(spanFinding?.message).toContain(
          'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent EffectFn span "Missing.span".'
        )

        const svcFinding = staleFindings.find((f) => f.nodeId === "ADR-0002:MissingService")
        expect(svcFinding).toBeDefined()
        expect(svcFinding?.message).toContain(
          'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent ServiceTag "MissingService".'
        )

        const errFinding = staleFindings.find((f) => f.nodeId === "ADR-0002:MissingError")
        expect(errFinding).toBeDefined()
        expect(errFinding?.message).toContain(
          'Governance doc "docs/adr/0002-stale.md" (ADR-0002) references non-existent TaggedError "MissingError".'
        )

        // Neither proposed nor superseded doc should produce findings
        expect(staleFindings.some((f) => f.nodeId.startsWith("SPEC-0001"))).toBe(false)
        expect(staleFindings.some((f) => f.nodeId.startsWith("ADR-0000"))).toBe(false)
      })
    )

    it("loads governance docs safely from disk even when folders do not exist", () => {
      const docs = loadGovernanceDocsFromDisk("/non/existent/repo/root")
      expect(Array.isArray(docs)).toBe(true)
      expect(docs).toHaveLength(0)

      const repoRoot = "/home/roan/WebstormProjects/effect-ts-harness"
      const repoDocs = loadGovernanceDocsFromDisk(repoRoot)
      expect(Array.isArray(repoDocs)).toBe(true)
    })

    it("discovers co-located and global governance docs while ignoring README.md and TEMPLATE.md", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "harness-gov-docs-"))
      try {
        mkdirSync(join(tempDir, "docs", "adr"), { recursive: true })
        mkdirSync(join(tempDir, "docs", "specs"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "es", "docs", "adr"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "es", "docs", "specs"), { recursive: true })

        writeFileSync(
          join(tempDir, "docs", "adr", "0001-monorepo-taxonomy.md"),
          `---
id: ADR-0001
status: accepted
---
# Monorepo Taxonomy
`
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "adr", "0001-do-event-store.md"),
          `---
id: ADR-ES-0001
status: accepted
---
# DO Event Store
`
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "specs", "2026-10-27-aggregate-root.md"),
          `---
id: SPEC-ES-0001
status: proposed
---
# Aggregate Root Spec
`
        )

        writeFileSync(
          join(tempDir, "docs", "adr", "README.md"),
          `---
id: ADR-README
status: accepted
---
# README
`
        )
        writeFileSync(
          join(tempDir, "docs", "adr", "TEMPLATE.md"),
          `---
id: ADR-TEMPLATE
status: accepted
---
# TEMPLATE
`
        )
        writeFileSync(
          join(tempDir, "docs", "specs", "README.md"),
          `---
id: SPEC-README
status: accepted
---
# README
`
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "adr", "README.md"),
          `---
id: LIB-ADR-README
status: accepted
---
# README
`
        )
        writeFileSync(
          join(tempDir, "libs", "es", "docs", "specs", "TEMPLATE.md"),
          `---
id: LIB-SPEC-TEMPLATE
status: accepted
---
# TEMPLATE
`
        )

        const docs = loadGovernanceDocsFromDisk(tempDir)
        expect(docs).toHaveLength(3)

        const paths = docs.map((d) => d.docPath)
        expect(paths).toEqual([
          "docs/adr/0001-monorepo-taxonomy.md",
          "libs/es/docs/adr/0001-do-event-store.md",
          "libs/es/docs/specs/2026-10-27-aggregate-root.md"
        ])

        const globalAdr = docs.find((d) => d.docPath === "docs/adr/0001-monorepo-taxonomy.md")
        expect(globalAdr).toBeDefined()
        expect(globalAdr?.id).toBe("ADR-0001")
        expect(globalAdr?.status).toBe("accepted")

        const colocatedAdr = docs.find(
          (d) => d.docPath === "libs/es/docs/adr/0001-do-event-store.md"
        )
        expect(colocatedAdr).toBeDefined()
        expect(colocatedAdr?.id).toBe("ADR-ES-0001")
        expect(colocatedAdr?.status).toBe("accepted")

        const colocatedSpec = docs.find(
          (d) => d.docPath === "libs/es/docs/specs/2026-10-27-aggregate-root.md"
        )
        expect(colocatedSpec).toBeDefined()
        expect(colocatedSpec?.id).toBe("SPEC-ES-0001")
        expect(colocatedSpec?.status).toBe("proposed")

        expect(paths.some((p) => p.endsWith("README.md"))).toBe(false)
        expect(paths.some((p) => p.endsWith("TEMPLATE.md"))).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe("decideMigrationSafety / checkMigrationSqlSafety", () => {
    it.effect("reports safe: true for clean CREATE TABLE and ALTER TABLE ADD COLUMN with DEFAULT", () =>
      Effect.gen(function* () {
        const report = yield* decideMigrationSafety({
          files: [
            {
              file: "migrations/0001_init.sql",
              sql: `
                CREATE TABLE users (
                  id INTEGER PRIMARY KEY,
                  name TEXT NOT NULL
                );
                --> statement-breakpoint
                ALTER TABLE users ADD COLUMN age INTEGER NOT NULL DEFAULT 0;
              `
            }
          ]
        })

        expect(report.safe).toBe(true)
        expect(report.requiresEscalation).toBe(false)
        expect(report.violations).toHaveLength(0)
      })
    )

    it("detects DROP TABLE, table rebuild, and ADD NOT NULL without DEFAULT via checkMigrationSqlSafety", () => {
      const report = checkMigrationSqlSafety([
        {
          file: "migrations/0002_drop.sql",
          sql: "DROP TABLE users;"
        },
        {
          file: "migrations/0003_rebuild.sql",
          sql: "CREATE TABLE `__new_users` (id INTEGER PRIMARY KEY); PRAGMA foreign_keys=OFF;"
        },
        {
          file: "migrations/0004_not_null.sql",
          sql: "ALTER TABLE photos ADD COLUMN owner_id TEXT NOT NULL;"
        }
      ])

      expect(report.safe).toBe(false)
      expect(report.requiresEscalation).toBe(true)
      expect(report.violations).toHaveLength(4)

      const kinds = report.violations.map((v) => v.kind)
      expect(kinds).toContain("drop-statement")
      expect(kinds).toContain("table-rebuild")
      expect(kinds).toContain("add-not-null-without-default")

      const notNull = report.violations.find((v) => v.kind === "add-not-null-without-default")
      expect(notNull?.file).toBe("migrations/0004_not_null.sql")
      expect(notNull?.message).toContain("ALTER TABLE ADD COLUMN NOT NULL without DEFAULT")
    })

    it("resists SQL comment spoofing of DEFAULT and detects SQLite ALTER TABLE DROP <col> without COLUMN keyword", () => {
      const report = checkMigrationSqlSafety([
        {
          file: "migrations/0005_adversarial.sql",
          sql: `
            -- DEFAULT 0 should not bypass NOT NULL check
            ALTER TABLE "default" ADD COLUMN tenant_id TEXT NOT NULL /* DEFAULT 'none' */;
            ALTER TABLE users DROP is_admin;
          `
        }
      ])

      expect(report.safe).toBe(false)
      expect(report.requiresEscalation).toBe(true)
      expect(report.violations.map((v) => v.kind)).toEqual([
        "add-not-null-without-default",
        "drop-statement"
      ])
    })
  })

  describe("decideSessionHandoff / buildSessionHandoff", () => {
    it("returns handoffMessage: null when clean with no active tasks", () => {
      const summary = buildSessionHandoff({
        stampValid: true,
        activeStubs: [],
        missingPlannedFns: [],
        frictionClusters: []
      })

      expect(summary.hasActiveTask).toBe(false)
      expect(summary.stampValid).toBe(true)
      expect(summary.recentFrictionCount).toBe(0)
      expect(summary.topFrictionSummary).toHaveLength(0)
      expect(summary.handoffMessage).toBeNull()
    })

    it.effect("builds a structured handoff message when tasks or friction exist", () =>
      Effect.gen(function* () {
        const clusters: ReadonlyArray<FrictionCluster> = [
          {
            key: "verify_failure::typecheck",
            kind: "verify_failure",
            summary: "tsc error in domain",
            detail: "detail 1",
            occurrences: 3,
            lastSeen: "2026-10-26T12:00:00.000Z"
          },
          {
            key: "route_miss::d1",
            kind: "route_miss",
            summary: "missing d1 route",
            detail: "detail 2",
            occurrences: 2,
            lastSeen: "2026-10-26T12:05:00.000Z"
          }
        ]

        const summary = yield* decideSessionHandoff({
          stampValid: false,
          stampReason: "Workspace files modified",
          activeStubs: ["libs/sample/domain/src/index.ts#greet"],
          missingPlannedFns: ["libs/sample/domain/src/index.ts#cancel"],
          frictionClusters: clusters
        })

        expect(summary.hasActiveTask).toBe(true)
        expect(summary.recentFrictionCount).toBe(5)
        expect(summary.topFrictionSummary).toEqual([
          "[verify_failure x3] tsc error in domain",
          "[route_miss x2] missing d1 route"
        ])

        expect(summary.handoffMessage).not.toBeNull()
        const msg = summary.handoffMessage!
        expect(msg).toContain("[Harness Context Handoff]")
        expect(msg).toContain(
          "Active stub() skeletons remaining: libs/sample/domain/src/index.ts#greet"
        )
        expect(msg).toContain(
          "Missing planned functions from plan-graph-snapshot: libs/sample/domain/src/index.ts#cancel"
        )
        expect(msg).toContain("Verify stamp status: INVALID (Workspace files modified)")
        expect(msg).toContain(
          "Recent friction events: [verify_failure x3] tsc error in domain; [route_miss x2] missing d1 route"
        )
      })
    )

    it.effect("surfaces stuck loop escalation and marks hasActiveTask when loop is thrashing", () =>
      Effect.gen(function* () {
        const thrashing = yield* decideLoopThrashing([
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:00:00.000Z",
            summary: "tsc error",
            detail: "error detail 1"
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:01:00.000Z",
            summary: "tsc error",
            detail: "error detail 2"
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:02:00.000Z",
            summary: "tsc error",
            detail: "error detail 3"
          }
        ])

        const summary = yield* decideSessionHandoff({
          stampValid: true,
          activeStubs: [],
          missingPlannedFns: [],
          frictionClusters: [],
          loopThrashing: thrashing
        })

        expect(summary.hasActiveTask).toBe(true)
        expect(summary.stuckLoopEscalation).not.toBeNull()
        expect(summary.stuckLoopEscalation).toContain("[ESCALATE: STUCK LOOP DETECTED]")
        expect(summary.handoffMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
      })
    )
  })

  describe("decideLoopThrashing / checkLoopThrashing (LoopCircuitBreaker.decide)", () => {
    it.effect("detects stuck loops when consecutive identical failure events meet threshold", () =>
      Effect.gen(function* () {
        const events: ReadonlyArray<FrictionEvent> = [
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:00:00.000Z",
            summary: "type error in domain",
            detail: "d1"
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:01:00.000Z",
            summary: "type error in domain",
            detail: "d2"
          },
          {
            kind: "route_miss",
            timestamp: "2026-10-27T10:01:30.000Z",
            summary: "missed route",
            detail: "d3"
          },
          {
            kind: "verify_failure",
            timestamp: "2026-10-27T10:02:00.000Z",
            summary: " type error in domain ",
            detail: "d4"
          }
        ]

        const status = yield* decideLoopThrashing(events, 3)
        expect(status.stuck).toBe(true)
        expect(status.consecutiveCount).toBe(3)
        expect(status.threshold).toBe(3)
        expect(status.repeatedKey).toBe("verify_failure::type error in domain")
        expect(status.summary).toBe(" type error in domain ")
        expect(status.escalationMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
        expect(status.escalationMessage).toContain("3 times consecutively")

        const syncStatus = checkLoopThrashing(events, 3)
        expect(syncStatus).toEqual(status)
      })
    )

    it("resets consecutive streak when failure summary changes and handles empty events", () => {
      const emptyStatus = checkLoopThrashing([])
      expect(emptyStatus.stuck).toBe(false)
      expect(emptyStatus.consecutiveCount).toBe(0)
      expect(emptyStatus.repeatedKey).toBeNull()
      expect(emptyStatus.summary).toBeNull()
      expect(emptyStatus.escalationMessage).toBeNull()

      const events: ReadonlyArray<FrictionEvent> = [
        {
          kind: "verify_failure",
          timestamp: "2026-10-27T10:00:00.000Z",
          summary: "syntax ban",
          detail: "d1"
        },
        {
          kind: "verify_failure",
          timestamp: "2026-10-27T10:01:00.000Z",
          summary: "syntax ban",
          detail: "d2"
        },
        {
          kind: "guard_escalation",
          timestamp: "2026-10-27T10:02:00.000Z",
          summary: "alchemy dev",
          detail: "d3"
        }
      ]

      const status = checkLoopThrashing(events, 3)
      expect(status.stuck).toBe(false)
      expect(status.consecutiveCount).toBe(1)
      expect(status.repeatedKey).toBe("guard_escalation::alchemy dev")
    })

    it.effect.prop(
      "LoopCircuitBreaker.decide: stuck is true if and only if consecutive failure count meets or exceeds threshold",
      {
        repeatCount: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: 6 })
        ),
        threshold: Schema.Int.check(
          Schema.isBetween({ minimum: 2, maximum: 5 })
        )
      },
      ({ repeatCount, threshold }) =>
        Effect.gen(function* () {
          const events: Array<FrictionEvent> = Array.from(
            { length: repeatCount },
            (_, i) => ({
              kind: "verify_failure" as const,
              timestamp: new Date(1000 + i * 1000).toISOString(),
              summary: "tsc error",
              detail: "error detail"
            })
          )
          const status = yield* decideLoopThrashing(events, threshold)
          const effectiveThreshold = Math.max(2, threshold)
          const expectedStuck = repeatCount >= effectiveThreshold
          expect(status.stuck).toBe(expectedStuck)
          expect(status.consecutiveCount).toBe(repeatCount)
          expect(status.threshold).toBe(effectiveThreshold)
          if (expectedStuck) {
            expect(status.escalationMessage).toContain("[ESCALATE: STUCK LOOP DETECTED]")
            expect(status.escalationMessage).toContain("verify_failure")
          } else {
            expect(status.escalationMessage).toBeNull()
          }
        })
    )
  })

  describe("classifyFileWrite (controlled write-surface)", () => {
    it("denies writes to protected read-only repos subtrees", () => {
      expect(classifyFileWrite("repos/effect/LLMS.md").verdict).toBe("deny")
      expect(classifyFileWrite("repos/alchemy/package.json").verdict).toBe("deny")
      expect(classifyFileWrite("repos/effect/src/index.ts").verdict).toBe("deny")
      expect(classifyFileWrite("repos/effect").verdict).toBe("deny")
    })

    it("denies direct modification of verify-stamp.json (forgery protection)", () => {
      expect(classifyFileWrite(".harness/verify-stamp.json").verdict).toBe("deny")
      expect(
        classifyFileWrite(".harness/worktrees/wt-1/verify-stamp.json").verdict
      ).toBe("deny")
      expect(
        classifyFileWrite("/home/user/project/.harness/verify-stamp.json").verdict
      ).toBe("deny")
    })

    it("denies modification of secret and credential files", () => {
      expect(classifyFileWrite(".env").verdict).toBe("deny")
      expect(classifyFileWrite(".env.local").verdict).toBe("deny")
      expect(classifyFileWrite(".dev.vars").verdict).toBe("deny")
      expect(classifyFileWrite("secret.pem").verdict).toBe("deny")
      expect(classifyFileWrite("server.key").verdict).toBe("deny")
    })

    it("allows template/example/sample environment files", () => {
      expect(classifyFileWrite(".env.example").verdict).toBe("allow")
      expect(classifyFileWrite(".env.template").verdict).toBe("allow")
      expect(classifyFileWrite(".env.sample").verdict).toBe("allow")
    })

    it("asks human confirmation for governance and linter policy changes", () => {
      expect(classifyFileWrite(".oxlintrc.json").verdict).toBe("ask")
      expect(classifyFileWrite("tools/oxlint/syntax-bans.js").verdict).toBe("ask")
      expect(classifyFileWrite("libs/harness/graph/policies.cedar").verdict).toBe("ask")
    })

    it("allows standard codebase modifications and handles empty input", () => {
      expect(classifyFileWrite("libs/sample/domain/src/index.ts").verdict).toBe("allow")
      expect(classifyFileWrite("apps/sample-web/src/client.ts").verdict).toBe("allow")
      expect(classifyFileWrite("").verdict).toBe("allow")
    })
  })

  describe("decideSpanBudgets / checkSpanBudgets", () => {
    it("detects n-plus-one-call violations when child span count exceeds budget", () => {
      const parent: SpanSample = {
        spanId: "parent-1",
        name: "Order.checkout",
        parentSpanId: null
      }
      const children: Array<SpanSample> = Array.from({ length: 6 }, (_, i) => ({
        spanId: `child-${i}`,
        name: "Db.query",
        parentSpanId: "parent-1"
      }))

      const violations = checkSpanBudgets({
        spans: [parent, ...children],
        maxRepeatedChildCalls: 5
      })

      expect(violations).toHaveLength(1)
      const v = violations[0]!
      expect(v.kind).toBe("n-plus-one-call")
      expect(v.parentSpan).toBe("Order.checkout")
      expect(v.targetSpan).toBe("Db.query")
      expect(v.count).toBe(6)
      expect(v.maxAllowed).toBe(5)
      expect(v.message).toContain("N+1 span repetition detected")
    })

    it.effect("detects span-duration-exceeded violations", () =>
      Effect.gen(function* () {
        const spans: ReadonlyArray<SpanSample> = [
          {
            spanId: "s1",
            name: "SlowOperation",
            parentSpanId: null,
            durationMs: 250.7
          },
          {
            spanId: "s2",
            name: "FastOperation",
            parentSpanId: null,
            durationMs: 45.2
          }
        ]

        const violations = yield* decideSpanBudgets({
          spans,
          maxSpanDurationMs: 100
        })

        expect(violations).toHaveLength(1)
        const v = violations[0]!
        expect(v.kind).toBe("span-duration-exceeded")
        expect(v.parentSpan).toBe("root")
        expect(v.targetSpan).toBe("SlowOperation")
        expect(v.count).toBe(251)
        expect(v.maxAllowed).toBe(100)
        expect(v.message).toContain("Span duration budget exceeded")
      })
    )
  })

  describe("resolveHarnessStateDir", () => {
    it("defaults to repoRoot/.harness when env vars are unset", () => {
      expect(resolveHarnessStateDir("/repo", {})).toBe("/repo/.harness")
    })

    it("respects HARNESS_WORKTREE_ID and sanitizes special characters", () => {
      expect(
        resolveHarnessStateDir("/repo", { HARNESS_WORKTREE_ID: "feature-branch" })
      ).toBe("/repo/.harness/worktrees/feature-branch")

      expect(
        resolveHarnessStateDir("/repo", { HARNESS_WORKTREE_ID: "feat/nested#branch" })
      ).toBe("/repo/.harness/worktrees/feat_nested_branch")
    })

    it("respects HARNESS_STATE_DIR (both relative and absolute)", () => {
      expect(
        resolveHarnessStateDir("/repo", { HARNESS_STATE_DIR: ".custom-state" })
      ).toBe("/repo/.custom-state")

      expect(
        resolveHarnessStateDir("/repo", { HARNESS_STATE_DIR: "/tmp/custom-state" })
      ).toBe("/tmp/custom-state")
    })
  })

  describe("decider property tests & AST mutation testing", () => {
    it.effect("flags domain *.decide without property-based test and passes when property test exists", () =>
      Effect.gen(function* () {
        const fnQualname = "libs/sample/domain/src/index.ts#Album.decide"
        const testId = "libs/sample/domain/test/index.test.ts::suite"

        const graphWithoutProp = buildHarnessGraph({
          fns: [
            {
              qualname: fnQualname,
              spanName: "Album.decide",
              packageTag: "domain",
              file: "libs/sample/domain/src/index.ts",
              line: 14,
              successType: "number",
              isStub: false
            }
          ],
          tests: [
            {
              testId,
              testFile: "libs/sample/domain/test/index.test.ts",
              testName: "libs/sample/domain/test/index.test.ts",
              lastTreeHash: "workspace",
              isPropertyTest: false
            }
          ],
          exercisesSpans: [
            {
              testId,
              calleeQualname: fnQualname,
              callCount: 1,
              receiverLayer: null
            }
          ]
        })

        const failingReport = yield* decideGraphEntropy({
          graph: graphWithoutProp,
          checkDeciderPropertyTests: true
        })

        expect(failingReport.clean).toBe(false)
        const missing = failingReport.findings.find(
          (f) => f.kind === "missing-decider-property-test"
        )
        expect(missing).toBeDefined()
        expect(missing?.nodeId).toBe("Album.decide")
        expect(missing?.message).toContain("0 Property-Based Tests")

        // Now test with isPropertyTest: true
        const graphWithProp = buildHarnessGraph({
          fns: [
            {
              qualname: fnQualname,
              spanName: "Album.decide",
              packageTag: "domain",
              file: "libs/sample/domain/src/index.ts",
              line: 14,
              successType: "number",
              isStub: false
            }
          ],
          tests: [
            {
              testId,
              testFile: "libs/sample/domain/test/index.test.ts",
              testName: "libs/sample/domain/test/index.test.ts",
              lastTreeHash: "workspace",
              isPropertyTest: true
            }
          ],
          exercisesSpans: [
            {
              testId,
              calleeQualname: fnQualname,
              callCount: 1,
              receiverLayer: null
            }
          ]
        })

        const passingReport = yield* decideGraphEntropy({
          graph: graphWithProp,
          checkDeciderPropertyTests: true
        })

        const deciderFindings = passingReport.findings.filter(
          (f) => f.kind === "missing-decider-property-test"
        )
        expect(deciderFindings).toHaveLength(0)
      })
    )

    it("discovers boundary, equality, and arithmetic mutants in domain code", () => {
      let root = process.cwd()
      while (root !== dirname(root)) {
        if (existsSync(join(root, "pnpm-workspace.yaml"))) {
          break
        }
        root = dirname(root)
      }
      const diskSource = readFileSync(
        join(root, "libs/sample/domain/src/index.ts"),
        "utf8"
      )
      // diskSource has >= and + 1; append equality operator for comprehensive discovery check
      const sampleSource = `${diskSource}\nconst isExact = (a: number) => a === 100\n`
      const mutants = discoverDomainMutants(
        "libs/sample/domain/src/index.ts",
        sampleSource
      )

      const boundary = mutants.find(
        (m) => m.category === "boundary-operator" && m.original === ">=" && m.replacement === ">"
      )
      expect(boundary).toBeDefined()
      expect(boundary?.line).toBe(20)
      expect(boundary?.mutatedSource).toContain("c > 100")

      const arithmetic = mutants.find(
        (m) => m.category === "arithmetic-operator" && m.original === "+ 1" && m.replacement === "- 1"
      )
      expect(arithmetic).toBeDefined()
      expect(arithmetic?.line).toBe(26)
      expect(arithmetic?.mutatedSource).toContain("currentCount - 1")

      const equality = mutants.find(
        (m) => m.category === "equality-operator" && m.original === "===" && m.replacement === "!=="
      )
      expect(equality).toBeDefined()
      expect(equality?.mutatedSource).toContain("a !== 100")
    })

    it.effect("evaluates mutation outcomes and computes correct mutation score", () =>
      Effect.gen(function* () {
        const dummyMutant1: CodeMutant = {
          id: "test:1:>=->>",
          file: "test.ts",
          line: 1,
          category: "boundary-operator",
          original: ">=",
          replacement: ">",
          mutatedSource: "x > 1"
        }
        const dummyMutant2: CodeMutant = {
          id: "test:2:+ 1->- 1",
          file: "test.ts",
          line: 2,
          category: "arithmetic-operator",
          original: "+ 1",
          replacement: "- 1",
          mutatedSource: "x - 1"
        }

        // All killed -> pass with score 1
        const allKilledReport = evaluateMutationOutcomes([
          { mutant: dummyMutant1, status: "killed" },
          { mutant: dummyMutant2, status: "killed" }
        ])
        expect(allKilledReport.passed).toBe(true)
        expect(allKilledReport.totalMutants).toBe(2)
        expect(allKilledReport.killedCount).toBe(2)
        expect(allKilledReport.survivedCount).toBe(0)
        expect(allKilledReport.mutationScore).toBe(1)
        expect(allKilledReport.survivedMutants).toHaveLength(0)

        // One survived -> fail with survivedMutants listing
        const oneSurvivedReport = yield* decideMutationReport({
          outcomes: [
            { mutant: dummyMutant1, status: "killed" },
            { mutant: dummyMutant2, status: "survived" }
          ]
        })
        expect(oneSurvivedReport.passed).toBe(false)
        expect(oneSurvivedReport.totalMutants).toBe(2)
        expect(oneSurvivedReport.killedCount).toBe(1)
        expect(oneSurvivedReport.survivedCount).toBe(1)
        expect(oneSurvivedReport.mutationScore).toBe(0.5)
        expect(oneSurvivedReport.survivedMutants).toEqual([dummyMutant2])
      })
    )
  })

  describe("decideEarsSpecQuality / lintEarsSpecMarkdown (EarsSpecLint.decide)", () => {
    it("accepts a valid EARS spec with sequential areas, **Source:**, and valid REQ rows", () => {
      const validMarkdown = `## Requirements

### 1 · Photo Gallery Core
**Source (API contract):** Defined in contract package.

| ID | Pattern | Requirement | Effect Symbol | Verification |
|---|---|---|---|---|
| REQ-1.1 | Ubiquitous | The Photo schema **shall** validate all photo identifiers. | Photo | test |
| REQ-1.2 | Event-driven | **When** a user requests a photo by ID, The PhotoService **shall** query the repository. | PhotoService.getPhoto | test |
| REQ-1.3 | Unwanted behaviour | **If** photo is missing, **then** The PhotoService **shall** fail with NotFoundError. | NotFoundError | test |
`
      const report = lintEarsSpecMarkdown("docs/specs/valid.md", validMarkdown)
      expect(report.clean).toBe(true)
      expect(report.requirementCount).toBe(3)
      expect(report.findings).toHaveLength(0)
    })

    it("rejects generic subject, weak modal, compound obligation, pattern mismatch, numbering gap, and forbidden column", () => {
      // 1. Generic subject
      const genericSubjMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The system **shall** validate input. | test |\n`
      const genericReport = lintEarsSpecMarkdown("docs/specs/test.md", genericSubjMd)
      expect(genericReport.clean).toBe(false)
      expect(genericReport.findings.some((f) => f.kind === "generic-subject")).toBe(true)

      // 2. Weak modal
      const weakModalMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The PhotoService should validate input. | test |\n`
      const weakReport = lintEarsSpecMarkdown("docs/specs/test.md", weakModalMd)
      expect(weakReport.clean).toBe(false)
      expect(weakReport.findings.some((f) => f.kind === "weak-modal")).toBe(true)

      // 3. Compound obligation
      const compoundMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The PhotoService **shall** save the record **and shall** notify subscribers. | test |\n`
      const compoundReport = lintEarsSpecMarkdown("docs/specs/test.md", compoundMd)
      expect(compoundReport.clean).toBe(false)
      expect(compoundReport.findings.some((f) => f.kind === "compound-obligation")).toBe(true)

      // 4. Pattern mismatch
      const patternMismatchMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Event-driven | The PhotoService **shall** save the record immediately. | test |\n`
      const mismatchReport = lintEarsSpecMarkdown("docs/specs/test.md", patternMismatchMd)
      expect(mismatchReport.clean).toBe(false)
      expect(mismatchReport.findings.some((f) => f.kind === "pattern-keyword-mismatch")).toBe(true)

      // 5. Numbering gap
      const gapMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n| REQ-1.1 | Ubiquitous | The PhotoService **shall** step 1. | test |\n| REQ-1.3 | Ubiquitous | The PhotoService **shall** step 3. | test |\n`
      const gapReport = lintEarsSpecMarkdown("docs/specs/test.md", gapMd)
      expect(gapReport.clean).toBe(false)
      expect(gapReport.findings.some((f) => f.kind === "numbering-gap")).toBe(true)

      // 6. Forbidden column
      const forbiddenMd = `## Requirements\n\n### 1 · Area\n**Source:** test\n\n| ID | Status | Pattern | Requirement | Verification |\n|---|---|---|---|---|\n| REQ-1.1 | Done | Ubiquitous | The PhotoService **shall** step 1. | test |\n`
      const forbiddenReport = lintEarsSpecMarkdown("docs/specs/test.md", forbiddenMd)
      expect(forbiddenReport.clean).toBe(false)
      expect(forbiddenReport.findings.some((f) => f.kind === "forbidden-column")).toBe(true)
    })

    it.effect("flags ears-spec-lint in decideGraphEntropy when governance doc has EARS violations", () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({})
        const report = yield* decideGraphEntropy({
          graph,
          governanceDocs: [
            {
              docPath: "libs/sample/docs/specs/2026-10-27-broken.md",
              id: "sample:SPEC-BROKEN",
              status: "accepted",
              markdown: "No requirements table in this file."
            }
          ]
        })
        expect(report.clean).toBe(false)
        const finding = report.findings.find((f) => f.kind === "ears-spec-lint")
        expect(finding).toBeDefined()
        expect(finding?.nodeId).toBe("sample:SPEC-BROKEN")
        expect(finding?.message).toContain("no-requirements-table")
      })
    )

    it.effect.prop(
      "EarsSpecLint.decide: validates N generated requirements cleanly",
      {
        requirementCount: Schema.Int.check(
          Schema.isBetween({ minimum: 1, maximum: 5 })
        )
      },
      ({ requirementCount }) =>
        Effect.gen(function* () {
          const rows = Array.from(
            { length: requirementCount },
            (_, i) =>
              `| REQ-1.${i + 1} | Ubiquitous | The Service${i + 1} **shall** execute step ${i + 1}. | test |`
          ).join("\n")

          const md = `## Requirements\n\n### 1 · Area\n**Source:** test source\n\n| ID | Pattern | Requirement | Verification |\n|---|---|---|---|\n${rows}\n`

          const report = yield* decideEarsSpecQuality({
            docPath: "docs/specs/generated.md",
            markdown: md
          })

          expect(report.clean).toBe(true)
          expect(report.requirementCount).toBe(requirementCount)
          expect(report.requirements).toHaveLength(requirementCount)
          expect(report.findings).toHaveLength(0)
        })
    )
  })

  describe("decideAdrDocQuality / lintAdrDocMarkdown", () => {
    const validCanonicalAdr = `---
id: test:ADR-0001
title: Deterministic ADR Linting
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/gates/src/adr-lint.ts
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Deterministic ADR Linting

## Context and Problem Statement

ADR documents need to follow canonical MADR format to ensure architectural integrity.
1. Documents drift without linter.
2. Unfilled placeholders slip into production.

We need automated mechanical gating.

## Decision Drivers

* Guarantee canonical 6-section MADR structure across all ADRs.
* Deterministically verify frontmatter, chosen options, and rejected alternatives.

## Considered Options

* **Option 1:** Pure TypeScript AST & Markdown Decider.
* **Option 2:** Unstructured Markdown without Linting.

## Decision Outcome

**Chosen option:** "Option 1" because deterministic gates provide instant mechanical feedback.

## Rejected Alternatives

### 1 · Unstructured Markdown without Linting
- **Why rejected:** Causes documentation drift and broken references across repos.

## Consequences and Enforcement

### Positive Consequences
- ADRs remain consistently structured and parseable.

### Negative Consequences and Trade-offs
- Authors must adhere to strict markdown sections.

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Canonical MADR | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | \`AdrDocLint.decide\` |
`

    it("accepts valid canonical ADR documents", () => {
      const report = lintAdrDocMarkdown("docs/adr/test.md", validCanonicalAdr)
      expect(report.clean).toBe(true)
      expect(report.findings).toHaveLength(0)

      let root = process.cwd()
      while (root !== dirname(root)) {
        if (existsSync(join(root, "pnpm-workspace.yaml"))) {
          break
        }
        root = dirname(root)
      }

      const harnessAdr = readFileSync(
        join(root, "libs/harness/docs/adr/0001-deterministic-gates-and-plan-as-code.md"),
        "utf8"
      )
      const harnessReport = lintAdrDocMarkdown(
        "libs/harness/docs/adr/0001-deterministic-gates-and-plan-as-code.md",
        harnessAdr
      )
      expect(harnessReport.clean).toBe(true)
      expect(harnessReport.findings).toHaveLength(0)

      const sampleAdr = readFileSync(
        join(root, "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md"),
        "utf8"
      )
      const sampleReport = lintAdrDocMarkdown(
        "libs/sample/docs/adr/0001-cloudflare-d1-do-sqlite-and-traceparent-boundaries.md",
        sampleAdr
      )
      expect(sampleReport.clean).toBe(true)
      expect(sampleReport.findings).toHaveLength(0)
    })

    it("rejects invalid frontmatter (missing enforced_by, missing symbols, superseded without superseded_by)", () => {
      // 1. Missing frontmatter entirely
      const noFmReport = lintAdrDocMarkdown("test.md", "# No Frontmatter")
      expect(noFmReport.clean).toBe(false)
      expect(noFmReport.findings.some((f) => f.kind === "adr-frontmatter-invalid")).toBe(true)

      // 2. Missing enforced_by
      const noEnforcedMd = `---
id: test:ADR-0001
title: Test
status: accepted
date: 2026-10-27
spans:
  - AdrDocLint.decide
---
`
      const noEnforcedReport = lintAdrDocMarkdown("test.md", noEnforcedMd)
      expect(noEnforcedReport.clean).toBe(false)
      expect(
        noEnforcedReport.findings.some(
          (f) => f.kind === "adr-frontmatter-invalid" && f.message.includes("enforced_by")
        )
      ).toBe(true)

      // 3. Missing governed symbols
      const noSymbolsMd = `---
id: test:ADR-0001
title: Test
status: accepted
date: 2026-10-27
enforced_by:
  - some/file.ts
---
`
      const noSymbolsReport = lintAdrDocMarkdown("test.md", noSymbolsMd)
      expect(noSymbolsReport.clean).toBe(false)
      expect(
        noSymbolsReport.findings.some(
          (f) => f.kind === "adr-frontmatter-invalid" && f.message.includes("govern")
        )
      ).toBe(true)

      // 4. Superseded without superseded_by
      const supersededMd = `---
id: test:ADR-0001
title: Test
status: superseded
date: 2026-10-27
enforced_by:
  - some/file.ts
spans:
  - AdrDocLint.decide
---
`
      const supersededReport = lintAdrDocMarkdown("test.md", supersededMd)
      expect(supersededReport.clean).toBe(false)
      expect(
        supersededReport.findings.some(
          (f) => f.kind === "adr-frontmatter-invalid" && f.message.includes("superseded_by")
        )
      ).toBe(true)
    })

    it("rejects missing or out-of-order canonical sections", () => {
      // Missing section
      const missingSectionMd = validCanonicalAdr.replace(
        "## Decision Drivers\n\n* Guarantee canonical 6-section MADR structure across all ADRs.\n* Deterministically verify frontmatter, chosen options, and rejected alternatives.",
        ""
      )
      const missingReport = lintAdrDocMarkdown("test.md", missingSectionMd)
      expect(missingReport.clean).toBe(false)
      expect(
        missingReport.findings.some(
          (f) => f.kind === "adr-section-structure" && f.message.includes("Decision Drivers")
        )
      ).toBe(true)

      // Out of order sections
      const outOfOrderMd = validCanonicalAdr.replace(
        "## Decision Drivers",
        "## TEMP_MARKER"
      ).replace(
        "## Considered Options",
        "## Decision Drivers"
      ).replace(
        "## TEMP_MARKER",
        "## Considered Options"
      )
      const outOfOrderReport = lintAdrDocMarkdown("test.md", outOfOrderMd)
      expect(outOfOrderReport.clean).toBe(false)
      expect(
        outOfOrderReport.findings.some(
          (f) => f.kind === "adr-section-structure" && f.message.includes("out of order")
        )
      ).toBe(true)
    })

    it("rejects missing chosen option in Decision Outcome", () => {
      const noChosenMd = validCanonicalAdr.replace(
        '**Chosen option:** "Option 1" because deterministic gates provide instant mechanical feedback.',
        "We chose Option 1 after careful evaluation."
      )
      const report = lintAdrDocMarkdown("test.md", noChosenMd)
      expect(report.clean).toBe(false)
      expect(report.findings.some((f) => f.kind === "adr-missing-chosen-option")).toBe(true)
    })

    it("rejects malformed rejected alternatives (missing ### 1 · or missing **Why rejected:**)", () => {
      // Missing ### 1 · subsection
      const noSubMd = validCanonicalAdr.replace(
        "### 1 · Unstructured Markdown without Linting\n- **Why rejected:** Causes documentation drift and broken references across repos.",
        "We considered unstructured markdown but didn't write it up."
      )
      const noSubReport = lintAdrDocMarkdown("test.md", noSubMd)
      expect(noSubReport.clean).toBe(false)
      expect(
        noSubReport.findings.some(
          (f) => f.kind === "adr-rejected-alternative-structure"
        )
      ).toBe(true)

      // Missing **Why rejected:**
      const noWhyMd = validCanonicalAdr.replace(
        "**Why rejected:**",
        "Reason for rejection:"
      )
      const noWhyReport = lintAdrDocMarkdown("test.md", noWhyMd)
      expect(noWhyReport.clean).toBe(false)
      expect(
        noWhyReport.findings.some(
          (f) => f.kind === "adr-rejected-alternative-structure" && f.message.includes("Why rejected")
        )
      ).toBe(true)
    })

    it("rejects missing enforcement table under Consequences and Enforcement", () => {
      const noTableMd = validCanonicalAdr.replace(
        /\| Rule \|[\s\S]*\| `AdrDocLint\.decide` \|/,
        "Enforcement is handled through code review."
      )
      const report = lintAdrDocMarkdown("test.md", noTableMd)
      expect(report.clean).toBe(false)
      expect(
        report.findings.some((f) => f.kind === "adr-missing-enforcement-table")
      ).toBe(true)
    })

    it.effect("flags adr-doc-lint in decideGraphEntropy when governance doc has ADR violations", () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({})
        const report = yield* decideGraphEntropy({
          graph,
          governanceDocs: [
            {
              docPath: "libs/sample/docs/adr/0002-broken.md",
              id: "sample:ADR-0002",
              status: "accepted",
              markdown: "# Broken ADR\n\nNo frontmatter here."
            }
          ]
        })
        expect(report.clean).toBe(false)
        const finding = report.findings.find((f) => f.kind === "adr-doc-lint")
        expect(finding).toBeDefined()
        expect(finding?.nodeId).toBe("sample:ADR-0002")
        expect(finding?.message).toContain("adr-frontmatter-invalid")
      })
    )

    it.effect.prop(
      "AdrDocLint.decide: validates canonical ADR with N rejected alternatives and M drivers cleanly",
      {
        rejectedCount: Schema.Int.check(
          Schema.isBetween({ minimum: 1, maximum: 4 })
        ),
        driverCount: Schema.Int.check(
          Schema.isBetween({ minimum: 2, maximum: 5 })
        )
      },
      ({ rejectedCount, driverCount }) =>
        Effect.gen(function* () {
          const drivers = Array.from(
            { length: driverCount },
            (_, i) => `* Driver requirement ${i + 1} for architectural compliance`
          ).join("\n")

          const options = Array.from(
            { length: rejectedCount + 1 },
            (_, i) => `* **Option ${i + 1}:** Approach ${i + 1}`
          ).join("\n")

          const rejectedAlternatives = Array.from(
            { length: rejectedCount },
            (_, i) =>
              `### ${i + 1} · Option ${i + 2}\n- **Why rejected:** Reasons for rejecting option ${i + 2}.`
          ).join("\n\n")

          const md = `---
id: test:ADR-0001
title: Test Architectural Decision Record
status: accepted
date: 2026-10-27
enforced_by:
  - libs/harness/gates/src/adr-lint.ts
spans:
  - AdrDocLint.decide
---

# test:ADR-0001: Test Architectural Decision Record

## Context and Problem Statement

Context and problem statement details here.

## Decision Drivers

${drivers}

## Considered Options

${options}

## Decision Outcome

**Chosen option:** "Option 1" because it satisfies all drivers.

## Rejected Alternatives

${rejectedAlternatives}

## Consequences and Enforcement

### Positive Consequences
- Positive outcome 1

### Negative Consequences and Trade-offs
- Trade-off 1

### Deterministic Enforcement
| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| --- | --- | --- | --- |
| Lint ADRs | libs/harness/gates/src/adr-lint.ts | AdrDocLint.decide | \`AdrDocLint.decide\` |
`

          const report = yield* decideAdrDocQuality({
            docPath: "docs/adr/test-0001.md",
            markdown: md
          })

          expect(report.clean).toBe(true)
          expect(report.findings).toHaveLength(0)
        })
    )
  })
})
