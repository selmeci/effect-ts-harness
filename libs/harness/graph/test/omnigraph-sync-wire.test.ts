import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { FetchLike } from "@modernrelay/omnigraph"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  diffOmnigraphBranches,
  invokeOmnigraphNamedQuery,
  mergeOmnigraphBranch,
  OmnigraphLoadError,
  queryOmnigraph,
  readGraphHeadMeta,
  RelationId,
  resolveOmnigraphBaseUrl,
  resolveOmnigraphTaskBranches,
  saveGraphSnapshot,
  syncToOmnigraphAndSnapshot,
  toOmnigraphNdjson,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"
import {
  OmnigraphSyncLive,
  decodeJson,
  type RecordedRequest,
  toUrlString,
} from "./helpers/omnigraph-gq-fixture.js"

describe("OmnigraphSync against mock wire protocol (Omnigraph-Http-Api: 0.14)", () => {
  const sampleGraph = buildHarnessGraph({
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
    services: [
      {
        tagId: "Greeter",
        name: "Greeter",
        packageTag: "service",
        file: "libs/sample/service/src/index.ts",
      },
    ],
    requiresService: [
      {
        fnQualname: "libs/sample/domain/src/index.ts#greet",
        tagId: "Greeter",
      },
    ],
  })

  it.effect("syncs with branch and forks from main using exact Omnigraph 0.14 protocol", () =>
    Effect.gen(function* () {
      const recorded: Array<RecordedRequest> = []

      const mockFetch: FetchLike = (input, init) => {
        const urlStr = toUrlString(input)
        const method = init?.method ?? "GET"
        const body = typeof init?.body === "string" ? init.body : undefined
        recorded.push({ url: urlStr, method, body })

        if (urlStr.endsWith("/healthz")) {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "Omnigraph-Http-Api": "0.14" },
            }),
          )
        }

        if (urlStr.endsWith("/graphs/harness/load")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                commit: { graph_commit_id: "cmt-100" },
                serverRef: "9d92f397",
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
          )
        }

        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "Omnigraph-Http-Api": "0.14" },
          }),
        )
      }

      const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-sync-branch-"))
      try {
        const syncRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
          branch: "plan/current",
          from: "main",
          fetch: mockFetch,
          snapshotPath: path.join(repoDir, ".harness", "test-snapshot.json"),
        }).pipe(Effect.provide(OmnigraphSyncLive))

        expect(syncRes.syncedToOmnigraph).toBe(true)
        const loadReq = recorded.find((r) => r.url.endsWith("/load"))
        expect(loadReq).toBeDefined()
        expect(loadReq?.body).toBeDefined()

        const parsedBody = decodeJson(loadReq?.body ?? "{}") as {
          readonly branch: string
          readonly from: string
          readonly data: string
        }
        expect(parsedBody.branch).toBe("plan/current")
        expect(parsedBody.from).toBe("main")

        const lines = parsedBody.data
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => decodeJson(l) as { readonly type?: string; readonly edge?: string })
        expect(lines.some((l) => l.type === "EffectFn")).toBe(true)
        expect(lines.some((l) => l.type === "EffectSignature")).toBe(true)
        expect(lines.some((l) => l.edge === "PlaysCallerRole")).toBe(true)
        expect(lines.every((l) => l.type !== "Any" && l.edge !== "Any")).toBe(true)
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true })
      }
    }),
  )

  it.effect("queries live Omnigraph, invokes stored queries, and diffs branches", () =>
    Effect.gen(function* () {
      const mockFetch: FetchLike = (input, _init) => {
        const urlStr = toUrlString(input)
        if (urlStr.endsWith("/healthz")) {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "Omnigraph-Http-Api": "0.14" },
            }),
          )
        }

        if (urlStr.includes("/graphs/harness/queries/resolve_effect_fn")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                rows: [
                  {
                    qualname: "libs/sample/domain/src/index.ts#greet",
                    spanName: "Sample.greet",
                  },
                ],
                graphCommitId: "cmt-200",
                serverRef: "9d92f397",
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
          )
        }

        if (urlStr.endsWith("/graphs/harness/query")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                rows: [{ count: 42 }],
                graphCommitId: "cmt-300",
                serverRef: "9d92f397",
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
          )
        }

        if (urlStr.includes("/graphs/harness/branches/diff")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                outcome: "ok",
                serverRef: "9d92f397",
                from_commit_id: "cmt-100",
                to_commit_id: "cmt-200",
                changes: [
                  {
                    id: "EffectFn:Sample.greet",
                    kind: "node",
                    op: "insert",
                    type: { id: "t-fn", name: "EffectFn" },
                    after: { properties: { spanName: "Sample.greet" } },
                  },
                ],
                netNodeCount: 1,
                netEdgeCount: 0,
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Omnigraph-Http-Api": "0.14",
                },
              },
            ),
          )
        }

        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "Omnigraph-Http-Api": "0.14" },
          }),
        )
      }

      const invokeRes = yield* invokeOmnigraphNamedQuery({
        name: "resolve_effect_fn",
        params: { spanOrQualname: "Sample.greet" },
        fetch: mockFetch,
      }).pipe(Effect.provide(OmnigraphSyncLive))

      expect(invokeRes.source).toBe("omnigraph")
      expect(invokeRes.degraded).toBe(false)
      expect(invokeRes.rows).toHaveLength(1)
      expect(invokeRes.rows[0]?.spanName).toBe("Sample.greet")

      const queryRes = yield* queryOmnigraph({
        query: "query count_nodes { match { $n } return { count: count($n) } }",
        fetch: mockFetch,
      }).pipe(Effect.provide(OmnigraphSyncLive))

      expect(queryRes).toHaveLength(1)
      expect(queryRes[0]?.count).toBe(42)

      const diffRes = yield* diffOmnigraphBranches({
        source: "impl/current",
        target: "plan/current",
        fetch: mockFetch,
      }).pipe(Effect.provide(OmnigraphSyncLive))

      expect(diffRes.changes).toHaveLength(1)
      expect(diffRes.changes[0]).toMatchObject({
        id: "EffectFn:Sample.greet",
        kind: "node",
        op: "insert",
        type: { id: "t-fn", name: "EffectFn" },
      })

      const failFetch: FetchLike = () =>
        Promise.resolve(
          new Response("Service Unavailable", {
            status: 503,
            headers: { "Omnigraph-Http-Api": "0.14" },
          }),
        )

      const queryErr = yield* Effect.flip(
        queryOmnigraph({
          query: "query count_nodes { match { $n } return { count: count($n) } }",
          fetch: failFetch,
        }).pipe(Effect.provide(OmnigraphSyncLive)),
      )
      expect(queryErr).toBeInstanceOf(OmnigraphLoadError)

      const diffErr = yield* Effect.flip(
        diffOmnigraphBranches({
          source: "impl/current",
          target: "plan/current",
          fetch: failFetch,
        }).pipe(Effect.provide(OmnigraphSyncLive)),
      )
      expect(diffErr).toBeInstanceOf(OmnigraphLoadError)
    }),
  )

  it("resolves Omnigraph base URL from server.json and isolates two repositories", () => {
    const repoA = fs.mkdtempSync(path.join(tmpdir(), "og-repo-a-"))
    const repoB = fs.mkdtempSync(path.join(tmpdir(), "og-repo-b-"))
    try {
      const clusterA = path.join(repoA, ".harness", "omnigraph-cluster")
      const clusterB = path.join(repoB, ".harness", "omnigraph-cluster")
      fs.mkdirSync(clusterA, { recursive: true })
      fs.mkdirSync(clusterB, { recursive: true })

      fs.writeFileSync(
        path.join(clusterA, "server.json"),
        JSON.stringify({
          pid: process.pid,
          port: 19991,
          baseUrl: "http://127.0.0.1:19991",
          canonicalRepoRoot: repoA,
          updatedAt: null,
        }),
      )
      fs.writeFileSync(
        path.join(clusterB, "server.json"),
        JSON.stringify({
          pid: process.pid,
          port: 24442,
          baseUrl: "http://127.0.0.1:24442",
          canonicalRepoRoot: repoB,
          updatedAt: null,
        }),
      )

      const urlA = resolveOmnigraphBaseUrl({ repoRoot: repoA }, {}, testHostIo)
      const urlB = resolveOmnigraphBaseUrl({ repoRoot: repoB }, {}, testHostIo)

      expect(urlA).toBe("http://127.0.0.1:19991")
      expect(urlB).toBe("http://127.0.0.1:24442")
      expect(urlA).not.toBe(urlB)

      // When server.json does not exist, port is derived deterministically from repoRoot
      const repoC = fs.mkdtempSync(path.join(tmpdir(), "og-repo-c-"))
      try {
        const urlC = resolveOmnigraphBaseUrl({ repoRoot: repoC }, {}, testHostIo)
        expect(urlC).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(urlC).not.toBe(urlA)
        expect(urlC).not.toBe(urlB)
      } finally {
        fs.rmSync(repoC, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(repoA, { recursive: true, force: true })
      fs.rmSync(repoB, { recursive: true, force: true })
    }
  })

  it.effect(
    "merges task branch into main, deletes cleanupBranches, and persists graph-head.json",
    () =>
      Effect.gen(function* () {
        const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-merge-cleanup-"))
        try {
          const gitDir = path.join(repoDir, ".git", "refs", "heads", "feat")
          fs.mkdirSync(gitDir, { recursive: true })
          fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/feat/my-pr\n")
          const commitSha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
          fs.writeFileSync(path.join(gitDir, "my-pr"), `${commitSha}\n`)

          const taskBranches = resolveOmnigraphTaskBranches(repoDir, testHostIo, {})
          expect(taskBranches).toEqual({
            planBranch: "plan/branch-feat_my-pr",
            implBranch: "impl/branch-feat_my-pr",
            mainBranch: "main",
          })

          const recorded: Array<RecordedRequest> = []
          const mockFetch: FetchLike = (input, init) => {
            const urlStr = toUrlString(input)
            const method = init?.method ?? "GET"
            const body = typeof init?.body === "string" ? init.body : undefined
            recorded.push({ url: urlStr, method, body })

            if (urlStr.endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, {
                  status: 200,
                  headers: { "Omnigraph-Http-Api": "0.14" },
                }),
              )
            }

            if (urlStr.endsWith("/graphs/harness/load")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "ok",
                    commit: { graph_commit_id: "cmt-load-1" },
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (urlStr.endsWith("/graphs/harness/branches") && method === "GET") {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "ok",
                    branches: [
                      taskBranches.mainBranch,
                      taskBranches.implBranch,
                      taskBranches.planBranch,
                    ],
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (urlStr.includes("/graphs/harness/branches/merge")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "already_up_to_date",
                    source: taskBranches.implBranch,
                    target: taskBranches.mainBranch,
                    branch_deleted: false,
                    branch_delete_error_details: { error: "simulated delete skip" },
                    commit: null,
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (method === "DELETE" && urlStr.includes("/graphs/harness/branches/")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "deleted",
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            return Promise.resolve(
              new Response("Not Found", {
                status: 404,
                headers: { "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          const snapshotPath = path.join(repoDir, ".harness", "graph-snapshot.json")
          const syncRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: taskBranches.implBranch,
            from: taskBranches.mainBranch,
            snapshotPath,
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(syncRes.syncedToOmnigraph).toBe(true)
          const headMeta = readGraphHeadMeta(repoDir, testHostIo)
          expect(headMeta?.headSha).toBe(commitSha)
          expect(headMeta?.gitBranch).toBe("feat/my-pr")

          recorded.length = 0
          yield* mergeOmnigraphBranch({
            repoRoot: repoDir,
            source: taskBranches.implBranch,
            target: taskBranches.mainBranch,
            cleanupBranches: [taskBranches.implBranch, taskBranches.planBranch],
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          const deleteRequests = recorded.filter((r) => r.method === "DELETE")
          expect(deleteRequests).toHaveLength(2)
          expect(deleteRequests[0]?.url).toContain("impl%2Fbranch-feat_my-pr")
          expect(deleteRequests[1]?.url).toContain("plan%2Fbranch-feat_my-pr")
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "F-15: syncToOmnigraphAndSnapshot returns syncedToOmnigraph: false with error when /load returns HTTP 500",
    () =>
      Effect.gen(function* () {
        const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-sync-err-"))
        try {
          const snapshotPath = path.join(repoDir, ".harness", "graph-snapshot.json")
          const mockFetch: FetchLike = (input) => {
            const urlStr = toUrlString(input)
            if (urlStr.includes("/graphs/harness/load")) {
              return Promise.resolve(
                new Response("Internal Server Error in Omnigraph", {
                  status: 500,
                  headers: { "Content-Type": "text/plain", "Omnigraph-Http-Api": "0.14" },
                }),
              )
            }
            return Promise.resolve(
              new Response("{}", {
                status: 200,
                headers: { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          const res = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: "impl/test-err",
            from: "main",
            snapshotPath,
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(res.syncedToOmnigraph).toBe(false)
          expect(res.error).toBeDefined()
          expect(res.error).toContain("500")
          expect(fs.existsSync(snapshotPath)).toBe(true)
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "F-1.1: mergeOmnigraphBranch fails with OmnigraphLoadError when /branches/merge returns HTTP 500 even if .harness/graph-snapshot.json exists",
    () =>
      Effect.gen(function* () {
        const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-merge-fail-"))
        try {
          const harnessDir = path.join(repoDir, ".harness")
          fs.mkdirSync(harnessDir, { recursive: true })
          const snapshotPath = path.join(harnessDir, "graph-snapshot.json")

          let loadCalledOnFallback = false
          const mockFetchWithMergeFail: FetchLike = (input, init) => {
            const urlStr = toUrlString(input)
            const method =
              init?.method ??
              (typeof input === "object" && "method" in input ? input.method : "GET")

            if (urlStr.endsWith("/graphs/harness/branches") && method === "GET") {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "ok",
                    branches: ["main", "impl/current"],
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            if (urlStr.includes("/graphs/harness/branches/merge")) {
              return Promise.resolve(
                new Response("Merge failed internally", {
                  status: 500,
                  headers: { "Content-Type": "text/plain", "Omnigraph-Http-Api": "0.14" },
                }),
              )
            }

            if (urlStr.includes("/graphs/harness/load") && method === "POST") {
              loadCalledOnFallback = true
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    outcome: "loaded",
                    commit: {
                      sha: "abc12345",
                      parentSha: null,
                      treeSha: "def",
                      author: "test",
                      message: "m",
                      timestamp: "t",
                    },
                    serverRef: "9d92f397",
                  }),
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "Omnigraph-Http-Api": "0.14",
                    },
                  },
                ),
              )
            }

            return Promise.resolve(
              new Response("{}", {
                status: 200,
                headers: { "Content-Type": "application/json", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          // Even when a valid .harness/graph-snapshot.json exists on disk, merge MUST fail with OmnigraphLoadError and NEVER call /load
          saveGraphSnapshot(sampleGraph, snapshotPath, testHostIo)
          const exit = yield* Effect.exit(
            mergeOmnigraphBranch({
              repoRoot: repoDir,
              source: "impl/current",
              target: "main",
              fetch: mockFetchWithMergeFail,
            }).pipe(Effect.provide(OmnigraphSyncLive)),
          )
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              const errOpt = Cause.findErrorOption(cause)
              match(errOpt)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value).toBeInstanceOf(OmnigraphLoadError)
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable("Expected OmnigraphLoadError")
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable("Expected mergeOmnigraphBranch to fail")
            })
            .exhaustive()
          expect(loadCalledOnFallback).toBe(false)
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  const makeComprehensiveNdjsonGraph = () =>
    buildHarnessGraph({
      fns: [
        {
          qualname: "libs/comprehensive/domain/src/index.ts#callerFn",
          spanName: "Caller.fn",
          file: "libs/comprehensive/domain/src/index.ts",
          line: 1,
          packageTag: "domain",
          successType: "string",
          inputSchema: "InputSchemaDef",
          outputSchema: "OutputSchemaDef",
          payloadSchemas: ["UsesSchemaDef"],
          isStub: false,
        },
        {
          qualname: "libs/comprehensive/domain/src/index.ts#calleeFn",
          spanName: "Callee.fn",
          file: "libs/comprehensive/domain/src/index.ts",
          line: 10,
          packageTag: "domain",
          successType: "void",
          isStub: false,
        },
        {
          qualname: "libs/comprehensive/infra/src/index.ts#httpHandler",
          spanName: "Http.handler",
          file: "libs/comprehensive/infra/src/index.ts",
          line: 20,
          packageTag: "infra",
          successType: "void",
          isStub: false,
        },
      ],
      services: [
        {
          tagId: "CompService",
          name: "CompService",
          packageTag: "service",
          file: "libs/comprehensive/service/src/index.ts",
        },
        {
          tagId: "LayerReqService",
          name: "LayerReqService",
          packageTag: "service",
          file: "libs/comprehensive/service/src/index.ts",
        },
      ],
      layers: [
        {
          qualname: "CompLayerLive",
          layerKind: "live",
          packageTag: "infra",
          file: "libs/comprehensive/infra/src/layer.ts",
        },
      ],
      errors: [
        {
          errorTag: "SigError",
          file: "libs/comprehensive/contract/src/errors.ts",
        },
        {
          errorTag: "LayerError",
          file: "libs/comprehensive/contract/src/errors.ts",
        },
        {
          errorTag: "HttpError",
          file: "libs/comprehensive/contract/src/errors.ts",
        },
      ],
      schemas: [
        {
          schemaName: "InputSchemaDef",
          file: "libs/comprehensive/contract/src/schemas.ts",
        },
        {
          schemaName: "OutputSchemaDef",
          file: "libs/comprehensive/contract/src/schemas.ts",
        },
        {
          schemaName: "UsesSchemaDef",
          file: "libs/comprehensive/contract/src/schemas.ts",
        },
        {
          schemaName: "HttpRequestSchema",
          file: "libs/comprehensive/contract/src/schemas.ts",
        },
        {
          schemaName: "HttpResponseSchema",
          file: "libs/comprehensive/contract/src/schemas.ts",
        },
      ],
      tests: [
        {
          testId: "libs/comprehensive/domain/test/index.test.ts::test 1",
          testFile: "libs/comprehensive/domain/test/index.test.ts",
          testName: "test 1",
        },
        {
          testId: "libs/comprehensive/infra/test/mig.test.ts::migration test",
          testFile: "libs/comprehensive/infra/test/mig.test.ts",
          testName: "migration test",
        },
      ],
      patternDocs: [
        {
          slug: "comp-pattern",
          path: "agent-patterns/comp.md",
          summary: "Comprehensive pattern",
        },
      ],
      adrDocs: [
        {
          id: "ADR-COMP",
          title: "Comprehensive ADR",
          status: "accepted",
          path: "docs/adr/comp.md",
          enforcedByFiles: [],
        },
      ],
      earsSpecs: [
        {
          id: "SPEC-COMP",
          title: "Comprehensive Spec",
          status: "accepted",
          path: "docs/specs/comp.md",
          enforcedByFiles: [],
        },
      ],
      requiresService: [
        {
          callerQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
          tagId: "CompService",
        },
      ],
      failsWith: [
        {
          callerQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
          errorTag: "SigError",
        },
      ],
      tracedCalls: [
        {
          callerQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
          calleeQualname: "libs/comprehensive/domain/src/index.ts#calleeFn",
          callCount: 2,
          receiverLayer: null,
        },
      ],
      providesService: [
        {
          layerQualname: "CompLayerLive",
          tagId: "CompService",
        },
      ],
      layerRequires: [
        {
          layerQualname: "CompLayerLive",
          tagId: "LayerReqService",
        },
      ],
      layerFlows: [
        {
          relationId: RelationId.make("LayerFlow:CompLayerLive"),
          layerQualname: "CompLayerLive",
          providesServices: ["CompService"],
          requiresServices: ["LayerReqService"],
          emittedErrors: ["LayerError"],
          file: "libs/comprehensive/infra/src/layer.ts",
          line: 1,
        },
      ],
      exercisesSpans: [
        {
          testId: "libs/comprehensive/domain/test/index.test.ts::test 1",
          calleeQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
          callCount: 1,
          receiverLayer: null,
        },
      ],
      governsSymbols: [
        {
          adrId: "ADR-COMP",
          targetKey: "libs/comprehensive/domain/src/index.ts#callerFn",
          targetKind: "EffectFn",
        },
      ],
      specifiesSymbols: [
        {
          specId: "SPEC-COMP",
          targetKey: "libs/comprehensive/domain/src/index.ts#callerFn",
          targetKind: "EffectFn",
        },
      ],
      traceabilityTuples: [
        {
          relationId: RelationId.make("TraceabilityTuple:pattern-and-test"),
          adrId: "ADR-COMP",
          earsSpecId: "SPEC-COMP",
          targetSymbolQualname: "libs/comprehensive/domain/src/index.ts#callerFn",
          verifyingTestQualnames: ["libs/comprehensive/domain/test/index.test.ts::test 1"],
          enforcingPatternPaths: ["agent-patterns/comp.md"],
        },
        {
          relationId: RelationId.make("TraceabilityTuple:realize-svc"),
          targetSymbolQualname: "CompService",
          verifyingTestQualnames: [],
        },
        {
          relationId: RelationId.make("TraceabilityTuple:realize-layer"),
          targetSymbolQualname: "CompLayerLive",
          verifyingTestQualnames: [],
        },
        {
          relationId: RelationId.make("TraceabilityTuple:realize-err"),
          targetSymbolQualname: "SigError",
          verifyingTestQualnames: [],
        },
        {
          relationId: RelationId.make("TraceabilityTuple:realize-schema"),
          targetSymbolQualname: "InputSchemaDef",
          verifyingTestQualnames: [],
        },
      ],
      httpEndpointTuples: [
        {
          relationId: RelationId.make("HttpEndpoint:CompEp"),
          endpointGroup: "Comp",
          endpointName: "handle",
          method: "POST",
          path: "/comp",
          handlerQualname: "libs/comprehensive/infra/src/index.ts#httpHandler",
          requestSchemaQualnames: ["HttpRequestSchema"],
          responseSchemaQualnames: ["HttpResponseSchema"],
          errorTags: ["HttpError"],
          file: "libs/comprehensive/infra/src/http.ts",
          line: 1,
        },
      ],
      migrationTuples: [
        {
          relationId: RelationId.make("Migration:1_comp_mig"),
          migrationId: "1_comp_mig",
          engine: "SqliteMigrator",
          moduleFile: "libs/comprehensive/infra/src/mig.ts",
          isDestructive: false,
          verifyingTestQualnames: ["libs/comprehensive/infra/test/mig.test.ts::migration test"],
          line: 1,
        },
      ],
    })

  it.effect(
    "F-29: every edge emitted by toOmnigraphNdjson on a comprehensive graph is declared in schema.pg",
    () =>
      Effect.gen(function* () {
        yield* Effect.void
        const schemaPath = path.resolve(import.meta.dirname, "../schema.pg")
        const schema = fs.readFileSync(schemaPath, "utf8")
        const edgeMatches = schema.matchAll(/^edge\s+([A-Za-z0-9_]+):/gm)
        const declaredEdgeTypes = new Set<string>()
        for (const m of edgeMatches) {
          if (m[1]) {
            declaredEdgeTypes.add(m[1])
          }
        }
        expect(declaredEdgeTypes.size).toBeGreaterThanOrEqual(25)

        const comprehensiveGraph = makeComprehensiveNdjsonGraph()

        const ndjson = toOmnigraphNdjson(comprehensiveGraph)
        const emittedEdgeNames = new Set<string>()

        for (const line of ndjson.split("\n")) {
          if (!line.trim()) continue
          const parsed = JSON.parse(line) as { readonly edge?: string }
          if (parsed.edge !== undefined) {
            emittedEdgeNames.add(parsed.edge)
            expect(declaredEdgeTypes.has(parsed.edge)).toBe(true)
          }
        }

        expect(emittedEdgeNames.size).toBeGreaterThanOrEqual(15)
        expect(emittedEdgeNames.has("PlaysCallerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysCalleeRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRequiresServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysFailsWithRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysInputSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysOutputSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysUsesSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysProviderLayerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysProvidedServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRequiredServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysLayerFailsWithRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysGoverningAdrRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysSpecifyingEarsRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingFnRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingServiceRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingLayerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingErrorRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRealizingSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysVerifyingTestRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysEnforcingPatternRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysExercisingTestRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysExercisedSpanRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysEndpointHandlerRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysRequestSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysResponseSchemaRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysEndpointErrorRole")).toBe(true)
        expect(emittedEdgeNames.has("PlaysMigrationVerifyingTestRole")).toBe(true)
      }),
  )
})
