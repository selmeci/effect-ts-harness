import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { FetchLike } from "@modernrelay/omnigraph"
import { Effect, Layer, Logger } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  decideOmnigraphReconcile,
  executeNamedGqQueryInMemory,
  type HarnessGqQueryName,
  invokeOmnigraphNamedQuery,
  loadHarnessGqQueriesText,
  loadHarnessPgSchemaText,
  mergeOmnigraphBranch,
  NodeKey,
  OmnigraphLoadError,
  OmnigraphReconcileInput,
  readGraphHeadMeta,
  RelationId,
  resolveGitHeadState,
  resolveOmnigraphTaskBranches,
  RoleName,
  writeGraphHeadMeta,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"
import { OmnigraphSyncLive, toUrlString } from "./helpers/omnigraph-gq-fixture.js"

describe("OmnigraphReconcile.decide and Git HEAD state tracking", () => {
  it.effect.prop(
    "evaluates OmnigraphReconcile.decide deterministically across all composite inputs",
    [OmnigraphReconcileInput],
    ([input]) =>
      Effect.gen(function* () {
        const decision = yield* decideOmnigraphReconcile(input)
        const worktreeTrimmed = input.worktreeSlug?.trim() ?? ""
        const branchTrimmed = input.currentGitBranch?.trim() ?? ""
        const expectedTargetBranch =
          worktreeTrimmed.length > 0
            ? `impl/wt-${worktreeTrimmed.replace(/[^a-zA-Z0-9._-]/g, "_")}`
            : branchTrimmed.length > 0 && branchTrimmed !== "main" && branchTrimmed !== "master"
              ? `impl/branch-${branchTrimmed.replace(/[^a-zA-Z0-9._-]/g, "_")}`
              : "main"
        expect(decision.targetOmnigraphBranch).toBe(expectedTargetBranch)
        if (!input.snapshotExists) {
          expect(decision).toEqual({
            needsReconcile: true,
            reason: "missing-snapshot",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        } else if (
          input.currentHeadSha !== null &&
          input.currentHeadSha.length > 0 &&
          input.recordedHeadSha !== input.currentHeadSha
        ) {
          expect(decision).toEqual({
            needsReconcile: true,
            reason: "head-sha-changed",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        } else if (
          input.currentGitBranch !== null &&
          input.recordedGitBranch !== null &&
          input.recordedGitBranch !== input.currentGitBranch
        ) {
          expect(decision).toEqual({
            needsReconcile: true,
            reason: "git-branch-changed",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        } else {
          expect(decision).toEqual({
            needsReconcile: false,
            reason: "up-to-date",
            targetOmnigraphBranch: expectedTargetBranch,
          })
        }
      }),
  )

  it("resolves Git HEAD state from loose refs, packed-refs, and linked worktrees", () => {
    const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-git-head-"))
    try {
      const refsDir = path.join(repoDir, ".git", "refs", "heads")
      fs.mkdirSync(refsDir, { recursive: true })
      const mainSha = "1111111111111111111111111111111111111111"
      const packedSha = "2222222222222222222222222222222222222222"
      fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n")
      fs.writeFileSync(path.join(refsDir, "main"), `${mainSha}\n`)
      fs.writeFileSync(
        path.join(repoDir, ".git", "packed-refs"),
        `# pack-refs with: peeled fully-peeled sorted\n${packedSha} refs/heads/release/v1\n`,
      )

      const mainHead = resolveGitHeadState(repoDir, testHostIo, {})
      expect(mainHead).toEqual({
        headSha: mainSha,
        gitBranch: "main",
      })
      expect(resolveOmnigraphTaskBranches(repoDir, testHostIo, {})).toEqual({
        planBranch: "plan/current",
        implBranch: "impl/current",
        mainBranch: "main",
      })

      fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/release/v1\n")
      const packedHead = resolveGitHeadState(repoDir, testHostIo, {})
      expect(packedHead).toEqual({
        headSha: packedSha,
        gitBranch: "release/v1",
      })
      expect(resolveOmnigraphTaskBranches(repoDir, testHostIo, {})).toEqual({
        planBranch: "plan/branch-release_v1",
        implBranch: "impl/branch-release_v1",
        mainBranch: "main",
      })

      writeGraphHeadMeta(repoDir, testHostIo, {
        headSha: packedSha,
        gitBranch: "release/v1",
      })
      const persisted = readGraphHeadMeta(repoDir, testHostIo)
      expect(persisted?.headSha).toBe(packedSha)
      expect(persisted?.gitBranch).toBe("release/v1")
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true })
    }
  })

  it("serves embedded schema.pg and queries/harness.gq assets verbatim", () => {
    const graphPkgDir = path.resolve(import.meta.dirname, "..")
    expect(loadHarnessPgSchemaText()).toBe(
      fs.readFileSync(path.resolve(graphPkgDir, "schema.pg"), "utf8"),
    )
    expect(loadHarnessGqQueriesText()).toBe(
      fs.readFileSync(path.resolve(graphPkgDir, "queries/harness.gq"), "utf8"),
    )
  })

  it.effect(
    "S-2: invokeOmnigraphNamedQuery includes both primary queries.invoke and fallback query failure reasons in fallbackError",
    () =>
      Effect.gen(function* () {
        const dualFailFetch: FetchLike = (input) => {
          const urlStr = toUrlString(input)
          if (urlStr.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, {
                status: 200,
                headers: { "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }
          if (urlStr.includes("/queries/")) {
            return Promise.resolve(
              new Response("primary-invoke-not-found", {
                status: 404,
                headers: {
                  "Content-Type": "text/plain",
                  "Omnigraph-Http-Api": "0.14",
                },
              }),
            )
          }
          if (urlStr.endsWith("/query")) {
            return Promise.resolve(
              new Response("fallback-query-unavailable", {
                status: 503,
                headers: {
                  "Content-Type": "text/plain",
                  "Omnigraph-Http-Api": "0.14",
                },
              }),
            )
          }
          return Promise.resolve(
            new Response("Not Found", {
              status: 404,
              headers: { "Omnigraph-Http-Api": "0.14" },
            }),
          )
        }

        const res = yield* invokeOmnigraphNamedQuery({
          name: "resolve_effect_fn",
          params: { spanOrQualname: "Sample.greet" },
          fallbackGraph: buildHarnessGraph({
            fns: [
              {
                qualname: "libs/sample/domain/src/index.ts#greet",
                spanName: "Sample.greet",
                file: "libs/sample/domain/src/index.ts",
                line: 4,
                packageTag: "domain",
                successType: "string",
                isStub: false,
              },
            ],
          }),
          fetch: dualFailFetch,
        }).pipe(Effect.provide(OmnigraphSyncLive))

        if (!res.degraded) {
          expect.unreachable("expected degraded memory-fallback result")
        }
        expect(res.source).toBe("memory-fallback")
        expect(res.fallbackError).toContain("HTTP 404")
        expect(res.fallbackError).toContain("HTTP 503")

        const noFallbackErr = yield* Effect.flip(
          invokeOmnigraphNamedQuery({
            name: "resolve_effect_fn",
            params: { spanOrQualname: "Sample.greet" },
            fetch: dualFailFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )
        expect(noFallbackErr).toBeInstanceOf(OmnigraphLoadError)
        const noFallbackMsg =
          noFallbackErr.cause instanceof Error
            ? noFallbackErr.cause.message
            : String(noFallbackErr.cause)
        expect(noFallbackMsg).toContain("HTTP 404")
        expect(noFallbackMsg).toContain("HTTP 503")
      }),
  )

  it.effect(
    "S-8e: mergeOmnigraphBranch logs a warning when cleanup branch delete fails without masking merge success",
    () =>
      Effect.gen(function* () {
        const warnings: Array<string> = []
        const captureWarningLogger = Logger.make((opts) => {
          if (opts.logLevel === "Warn") {
            warnings.push(String(opts.message))
          }
        })

        const cleanupFailFetch: FetchLike = (input, init) => {
          const urlStr = toUrlString(input)
          const method = init?.method ?? "GET"
          if (urlStr.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, {
                status: 200,
                headers: { "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }
          if (method === "GET" && urlStr.endsWith("/graphs/harness/branches")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  outcome: "ok",
                  branches: ["main", "impl/current", "plan/stale"],
                  serverRef: "9d92f397",
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" },
                },
              ),
            )
          }
          if (method === "POST" && urlStr.endsWith("/graphs/harness/branches/merge")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  outcome: "already_up_to_date",
                  source: "impl/current",
                  target: "main",
                  branch_deleted: true,
                  commit: null,
                  serverRef: "9d92f397",
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" },
                },
              ),
            )
          }
          if (method === "DELETE" && urlStr.includes("/graphs/harness/branches/")) {
            return Promise.resolve(
              new Response("cleanup-delete-denied", {
                status: 500,
                headers: { "Content-Type": "text/plain", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }
          return Promise.resolve(
            new Response("Not Found", { status: 404, headers: { "Omnigraph-Http-Api": "0.14" } }),
          )
        }

        yield* mergeOmnigraphBranch({
          source: "impl/current",
          target: "main",
          cleanupBranches: ["plan/stale"],
          fetch: cleanupFailFetch,
        }).pipe(
          Effect.provide(Layer.mergeAll(OmnigraphSyncLive, Logger.layer([captureWarningLogger]))),
        )

        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("plan/stale")
        expect(warnings[0]).toContain("HTTP 500")
      }),
  )

  it.effect(
    "F-11.1a: mergeOmnigraphBranch fails with OmnigraphLoadError when source branch is missing",
    () =>
      Effect.gen(function* () {
        let createCalled = false
        const missingSourceFetch: FetchLike = (input, init) => {
          const urlStr = toUrlString(input)
          const method = init?.method ?? "GET"
          if (urlStr.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          if (method === "GET" && urlStr.endsWith("/graphs/harness/branches")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ outcome: "ok", branches: ["main"], serverRef: "ref-1" }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" },
                },
              ),
            )
          }
          if (method === "POST" && urlStr.endsWith("/graphs/harness/branches")) {
            createCalled = true
          }
          return Promise.resolve(
            new Response("Not Found", { status: 404, headers: { "Omnigraph-Http-Api": "0.14" } }),
          )
        }

        const err = yield* Effect.flip(
          mergeOmnigraphBranch({
            source: "impl/missing",
            target: "main",
            fetch: missingSourceFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )
        expect(err).toBeInstanceOf(OmnigraphLoadError)
        expect(createCalled).toBe(false)
        expect(err.cause instanceof Error ? err.cause.message : String(err.cause)).toContain(
          "impl/missing",
        )
      }),
  )

  it.effect(
    "F-12.1: invokeNamedQuery logs Effect.logWarning with primary and fallback causes before memory-fallback",
    () =>
      Effect.gen(function* () {
        const warnings: Array<string> = []
        const captureLogger = Logger.make((opts) => {
          if (opts.logLevel === "Warn") {
            warnings.push(String(opts.message))
          }
        })
        const failFetch: FetchLike = (input) => {
          const urlStr = toUrlString(input)
          if (urlStr.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          if (urlStr.includes("/queries/")) {
            return Promise.resolve(
              new Response("primary-404", {
                status: 404,
                headers: { "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }
          return Promise.resolve(
            new Response("fallback-502", {
              status: 502,
              headers: { "Omnigraph-Http-Api": "0.14" },
            }),
          )
        }

        const res = yield* invokeOmnigraphNamedQuery({
          name: "resolve_effect_fn",
          params: { spanOrQualname: "Demo.fn" },
          fallbackGraph: buildHarnessGraph({
            fns: [
              {
                qualname: "libs/demo/src/index.ts#fn",
                spanName: "Demo.fn",
                file: "libs/demo/src/index.ts",
                line: 1,
                packageTag: "domain",
                successType: "void",
                isStub: false,
              },
            ],
          }),
          fetch: failFetch,
        }).pipe(Effect.provide(Layer.mergeAll(OmnigraphSyncLive, Logger.layer([captureLogger]))))

        expect(res.source).toBe("memory-fallback")
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain("HTTP 404")
        expect(warnings[0]).toContain("HTTP 502")
      }),
  )

  it.effect(
    "F-12.2: invokeNamedQuery rejects unknown query name cleanly with OmnigraphLoadError",
    () =>
      Effect.gen(function* () {
        const okFetch: FetchLike = () =>
          Promise.resolve(
            new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
          )
        const err = yield* Effect.flip(
          invokeOmnigraphNamedQuery({
            name: "unknown_query" as HarnessGqQueryName,
            fetch: okFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )
        expect(err).toBeInstanceOf(OmnigraphLoadError)
        expect(err.cause instanceof Error ? err.cause.message : String(err.cause)).toContain(
          "Unknown named GQ query",
        )
      }),
  )

  it("F-16.1: ontology_realized_by_doc traverses governing-adr, specifying-ears, and realizing-symbol edges", () => {
    const base = buildHarnessGraph({
      adrDocs: [
        {
          id: "ADR-9999",
          path: "docs/adr/9999-test.md",
          title: "Test ADR",
          status: "accepted",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      earsSpecs: [
        {
          id: "SPEC-9999",
          path: "docs/specs/9999-test.md",
          title: "Test Spec",
          status: "accepted",
          enforcedByFiles: [],
          referencedSpans: [],
          referencedServices: [],
          referencedErrors: [],
        },
      ],
      fns: [
        {
          qualname: "libs/demo/domain/src/edge-realized.ts#run",
          spanName: "Demo.run",
          file: "libs/demo/domain/src/edge-realized.ts",
          line: 10,
          packageTag: "domain",
          isStub: false,
        },
      ],
    })

    const edgeBackedGraph = {
      ...base,
      graph: Graph.mutate(base.graph, (mutable) => {
        const tupleIdx = Graph.addNode(mutable, {
          _tag: "TraceabilityTuple",
          relationId: RelationId.make("TraceabilityTuple:edge-only-1"),
          targetSymbolQualname: "fallback-unused-qualname",
          requirementId: "REQ-9.1",
          earsPattern: "Event-driven",
          verifyingTestQualnames: [],
        })
        let adrIdx: Graph.NodeIndex | undefined
        let specIdx: Graph.NodeIndex | undefined
        let fnIdx: Graph.NodeIndex | undefined
        for (const [idx, n] of Graph.nodes(mutable)) {
          match(n)
            .with({ _tag: "AdrDoc" }, () => {
              adrIdx = idx
            })
            .with({ _tag: "EarsSpec" }, () => {
              specIdx = idx
            })
            .with({ _tag: "EffectFn" }, () => {
              fnIdx = idx
            })
            .otherwise(() => {})
        }
        if (adrIdx !== undefined) {
          Graph.addEdge(mutable, tupleIdx, adrIdx, {
            _tag: "PlaysRole",
            relationId: RelationId.make("TraceabilityTuple:edge-only-1"),
            entityKey: NodeKey.make("AdrDoc:ADR-9999"),
            role: RoleName.make("governing-adr"),
            archimateRelation: "Influence",
          })
        }
        if (specIdx !== undefined) {
          Graph.addEdge(mutable, tupleIdx, specIdx, {
            _tag: "PlaysRole",
            relationId: RelationId.make("TraceabilityTuple:edge-only-1"),
            entityKey: NodeKey.make("EarsSpec:SPEC-9999"),
            role: RoleName.make("specifying-ears"),
            archimateRelation: "Realization",
          })
        }
        if (fnIdx !== undefined) {
          Graph.addEdge(mutable, tupleIdx, fnIdx, {
            _tag: "PlaysRole",
            relationId: RelationId.make("TraceabilityTuple:edge-only-1"),
            entityKey: NodeKey.make("libs/demo/domain/src/edge-realized.ts#run"),
            role: RoleName.make("realizing-symbol"),
            archimateRelation: "Realization",
          })
        }
      }),
    }

    const adrRows = executeNamedGqQueryInMemory(edgeBackedGraph, "ontology_realized_by_doc", {
      docId: "ADR-9999",
    })
    expect(adrRows).toHaveLength(1)
    expect(adrRows[0]?.adrId).toBe("ADR-9999")
    expect(adrRows[0]?.earsSpecId).toBe("SPEC-9999")
    expect(adrRows[0]?.artifactQualname).toBe("libs/demo/domain/src/edge-realized.ts#run")

    const specRows = executeNamedGqQueryInMemory(edgeBackedGraph, "ontology_realized_by_doc", {
      docId: "SPEC-9999",
    })
    expect(specRows).toHaveLength(1)
    expect(specRows[0]?.tupleId).toBe("TraceabilityTuple:edge-only-1")
  })

  it.effect(
    "F-11.1: invokeOmnigraphNamedQuery fails closed on 401/403/400 without falling back to memory-fallback",
    () =>
      Effect.gen(function* () {
        const fallbackGraph = buildHarnessGraph({
          fns: [
            {
              qualname: "libs/sample/domain/src/index.ts#greet",
              spanName: "Sample.greet",
              file: "libs/sample/domain/src/index.ts",
              line: 4,
              packageTag: "domain",
              successType: "string",
              isStub: false,
            },
          ],
        })

        for (const status of [401, 403, 400] as const) {
          const authFailFetch: FetchLike = (input) => {
            if (toUrlString(input).endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            return Promise.resolve(
              new Response(`HTTP ${status} error`, {
                status,
                headers: { "Content-Type": "text/plain", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          const err = yield* Effect.flip(
            invokeOmnigraphNamedQuery({
              name: "resolve_effect_fn",
              params: { spanOrQualname: "Sample.greet" },
              fallbackGraph,
              fetch: authFailFetch,
            }).pipe(Effect.provide(OmnigraphSyncLive)),
          )
          expect(err).toBeInstanceOf(OmnigraphLoadError)
          const msg = err.cause instanceof Error ? err.cause.message : String(err.cause)
          expect(msg).toContain(String(status))
        }
      }),
  )

  it.effect(
    "P1: decideOmnigraphReconcile resolves impl/wt-<slug> when worktreeSlug is provided",
    () =>
      Effect.gen(function* () {
        const decision = yield* decideOmnigraphReconcile({
          snapshotExists: true,
          recordedHeadSha: "sha-1",
          currentHeadSha: "sha-1",
          recordedGitBranch: "main",
          currentGitBranch: "main",
          worktreeSlug: "subagent/fix#1",
        })
        expect(decision.needsReconcile).toBe(false)
        expect(decision.targetOmnigraphBranch).toBe("impl/wt-subagent_fix_1")
      }),
  )
})
