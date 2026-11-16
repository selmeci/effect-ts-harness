import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import {
  OmnigraphBranchName,
  OmnigraphChangeCursor,
  OmnigraphCommitId,
  OmnigraphEntityId,
  OmnigraphEntityKind,
  OmnigraphMergeConflictError,
  OmnigraphPreconditionError,
  OmnigraphTypeName,
  WorkspaceFilePath,
} from "@harness/contract"
import { runWithTestTracer } from "@harness/ingest"
import { Cause, Effect, Schema } from "effect"
import type { FetchLike } from "@modernrelay/omnigraph"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  dryRunMergeOmnigraphBranches,
  makeOmnigraphClient,
  makeOmnigraphSyncLayer,
  mergeOmnigraphBranch,
  mutateOmnigraphConditional,
  OmnigraphLoadError,
  OmnigraphSync,
  PackageTag,
  pollOmnigraphChanges,
  readGraphHeadMeta,
  syncToOmnigraphAndSnapshot,
  toOmnigraphServerNdjson,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

const OmnigraphSyncLive = makeOmnigraphSyncLayer(testHostIo)

const jsonResponse = (body: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Omnigraph-Http-Api": "0.14",
        ...extraHeaders,
      },
    }),
  )

const sampleGraph = buildHarnessGraph({
  fns: [
    {
      qualname: "libs/sample/src/fn.ts#Sample.ping",
      spanName: "Sample.ping",
      packageTag: PackageTag.make("domain"),
      file: WorkspaceFilePath.make("libs/sample/src/fn.ts"),
      line: 10,
      isStub: false,
    },
  ],
})

const toUrlString = (input: Parameters<FetchLike>[0]): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

describe("Omnigraph v0.14.0 native capabilities (RFC-0009)", () => {
  it("toOmnigraphServerNdjson emits top-level id on every node and includes 3 canonical GraphPolicy nodes", () => {
    const ndjson = toOmnigraphServerNdjson(sampleGraph)
    const lines = ndjson
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            readonly type?: string
            readonly id?: string
            readonly data?: Record<string, unknown>
          },
      )

    const effectFnLine = lines.find((l) => l.type === "EffectFn")
    expect(effectFnLine?.id).toBe("libs/sample/src/fn.ts#Sample.ping")

    const policyLines = lines.filter((l) => l.type === "GraphPolicy")
    expect(policyLines.map((p) => p.id)).toEqual([
      "policy-0001-domain-spans-verified",
      "policy-0002-no-orphan-effect-signatures",
      "policy-0003-AcceptedSpecsEnforced",
    ])

    const emptyGraph = buildHarnessGraph({})
    expect(toOmnigraphServerNdjson(emptyGraph)).toBe("")
  })

  it.effect(
    "syncToOmnigraphAndSnapshot uses mode=overwrite without DELETE branch and persists commitId to graph-head.json",
    () =>
      Effect.gen(function* () {
        const repoDir = fs.mkdtempSync(path.join(tmpdir(), "og-v014-sync-"))
        try {
          fs.mkdirSync(path.join(repoDir, ".git", "refs", "heads", "feat"), { recursive: true })
          fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/feat/v014\n")
          fs.writeFileSync(
            path.join(repoDir, ".git", "refs", "heads", "feat", "v014"),
            "abcdef1234567890\n",
          )

          const requests: Array<{
            readonly method: string
            readonly url: string
            readonly body?: unknown
          }> = []
          const mockFetch: FetchLike = (input, init) => {
            const url = toUrlString(input)
            const method = init?.method ?? "GET"
            const parsedBody =
              typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined
            requests.push({ method, url, body: parsedBody })

            if (url.endsWith("/graphs/harness/load")) {
              return jsonResponse({
                branch: "plan/v014",
                branch_created: true,
                commit: {
                  graph_commit_id: "cmt-v014-001",
                  created_at: 1000,
                  graph_manifest_version: 1,
                  kind: "published",
                },
                edges: [],
                embedding_generation: null,
                mode: "overwrite",
              })
            }
            return jsonResponse({})
          }

          const snapshotPath = path.join(repoDir, ".harness", "graph-snapshot.json")
          const { result: syncRes, spans } = yield* runWithTestTracer(
            "omnigraph-v014.sync",
            syncToOmnigraphAndSnapshot(sampleGraph, {
              repoRoot: repoDir,
              branch: "plan/v014",
              from: "main",
              snapshotPath,
              fetch: mockFetch,
            }).pipe(Effect.provide(OmnigraphSyncLive)),
            new Map(),
          )

          expect(syncRes.syncedToOmnigraph).toBe(true)
          expect(syncRes.commitId).toBe("cmt-v014-001")
          expect(requests.some((r) => r.method === "DELETE")).toBe(false)
          const loadReq = requests.find((r) => r.url.endsWith("/graphs/harness/load"))
          expect((loadReq?.body as { readonly mode?: string })?.mode).toBe("overwrite")

          const meta = readGraphHeadMeta(repoDir, testHostIo)
          expect(meta?.omnigraphCommitId).toBe("cmt-v014-001")
          expect(spans.some((s) => s.name === "OmnigraphSync.sync")).toBe(true)
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect("mergeOmnigraphBranch sends deleteBranch=true", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly method: string
        readonly url: string
        readonly body?: unknown
      }> = []
      const mockFetch: FetchLike = (input, init) => {
        const url = toUrlString(input)
        const method = init?.method ?? "GET"
        const parsedBody =
          typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined
        requests.push({ method, url, body: parsedBody })

        if (url.endsWith("/graphs/harness/branches") && method === "GET") {
          return jsonResponse({ branches: ["main", "impl/v014"] })
        }
        if (url.endsWith("/graphs/harness/branches/merge")) {
          return jsonResponse({
            outcome: "fast_forward",
            source: "impl/v014",
            target: "main",
            branch_deleted: true,
            commit: {
              graph_commit_id: "cmt-merge-1",
              created_at: 1001,
              graph_manifest_version: 1,
              graph_branch: "main",
              parent_commit_id: "cmt-parent-0",
              merged_parent_commit_id: "cmt-impl-0",
              kind: "published",
              published: true,
            },
          })
        }
        return jsonResponse({})
      }

      yield* mergeOmnigraphBranch({
        source: "impl/v014",
        target: "main",
        cleanupBranches: ["impl/v014"],
        fetch: mockFetch,
      }).pipe(Effect.provide(OmnigraphSyncLive))

      const mergeReq = requests.find((r) => r.url.endsWith("/graphs/harness/branches/merge"))
      expect((mergeReq?.body as { readonly delete_branch?: boolean })?.delete_branch).toBe(true)
      expect(requests.some((r) => r.method === "DELETE")).toBe(false)
    }),
  )

  it.effect(
    "dryRunMergeOmnigraphBranches succeeds on clean merge and fails with OmnigraphMergeConflictError on 409",
    () =>
      Effect.gen(function* () {
        const cleanFetch: FetchLike = () =>
          jsonResponse({
            outcome: "merged",
            source: "impl/clean",
            target: "main",
            dry_run: true,
            commit: null,
          })

        const { result: cleanRes, spans } = yield* runWithTestTracer(
          "omnigraph-v014.dryRunMerge",
          dryRunMergeOmnigraphBranches({
            source: OmnigraphBranchName.make("impl/clean"),
            target: OmnigraphBranchName.make("main"),
            fetch: cleanFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
          new Map(),
        )
        expect(cleanRes.dryRun).toBe(true)
        expect(cleanRes.outcome).toBe("merged")
        expect(spans.some((s) => s.name === "OmnigraphSync.dryRunMerge")).toBe(true)

        const conflictFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse(
            {
              code: "conflict",
              message: "Merge conflict",
              merge_conflicts: [
                {
                  kind: "divergent_update",
                  entity_kind: "node",
                  type_name: "EffectFn",
                  entity_id: "Sample.ping",
                  message: "Concurrent edit on isStub",
                },
              ],
            },
            409,
          )
        }

        const exit = yield* Effect.exit(
          dryRunMergeOmnigraphBranches({
            source: OmnigraphBranchName.make("impl/conflict"),
            target: OmnigraphBranchName.make("main"),
            fetch: conflictFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )

        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value: err }) => {
                expect(err).toBeInstanceOf(OmnigraphMergeConflictError)
                if (err instanceof OmnigraphMergeConflictError) {
                  expect(err.conflicts).toHaveLength(1)
                  expect(err.conflicts[0]?.kind).toBe("divergent_update")
                }
              })
              .with({ _tag: "None" }, () => expect.fail("Expected typed error"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected dryRunMerge failure"))
          .exhaustive()
      }),
  )

  it.effect(
    "mutateOmnigraphConditional sends Omnigraph-If-Graph-Commit and fails with OmnigraphPreconditionError on 412",
    () =>
      Effect.gen(function* () {
        let seenHeader: string | null = null
        const okFetch: FetchLike = (_input, init) => {
          const headers = new Headers(init?.headers)
          seenHeader = headers.get("Omnigraph-If-Graph-Commit")
          return jsonResponse({
            branch: "main",
            affected_nodes: 1,
            affected_edges: 0,
            query_name: "updateStub",
            commit: {
              graph_commit_id: "cmt-next-2",
              created_at: 1002,
              graph_manifest_version: 1,
              kind: "published",
            },
          })
        }

        const { result: mutRes, spans } = yield* runWithTestTracer(
          "omnigraph-v014.mutateConditional",
          mutateOmnigraphConditional({
            branch: OmnigraphBranchName.make("main"),
            query: "update $fn: EffectFn set { isStub: false }",
            ifGraphCommit: OmnigraphCommitId.make("cmt-base-1"),
            fetch: okFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
          new Map(),
        )
        expect(seenHeader).toBe("cmt-base-1")
        expect(mutRes.commitId).toBe("cmt-next-2")
        expect(spans.some((s) => s.name === "OmnigraphSync.mutateConditional")).toBe(true)

        const staleFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse(
            {
              code: "precondition_failed",
              message: "Head moved",
              precondition_failure: {
                expected: "cmt-base-1",
                actual: "cmt-other-9",
              },
            },
            412,
          )
        }

        const exit = yield* Effect.exit(
          mutateOmnigraphConditional({
            branch: OmnigraphBranchName.make("main"),
            query: "update $fn: EffectFn set { isStub: false }",
            ifGraphCommit: OmnigraphCommitId.make("cmt-base-1"),
            fetch: staleFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )

        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value: err }) => {
                expect(err).toBeInstanceOf(OmnigraphPreconditionError)
                if (err instanceof OmnigraphPreconditionError) {
                  expect(err.expectedCommit).toBe("cmt-base-1")
                  expect(err.actualCommit).toBe("cmt-other-9")
                }
              })
              .with({ _tag: "None" }, () => expect.fail("Expected typed error"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected precondition failure"))
          .exhaustive()
      }),
  )

  it.effect(
    "pollOmnigraphChanges advances cursor and recovers via baseline on HTTP 410 Gone",
    () =>
      Effect.gen(function* () {
        const normalFetch: FetchLike = () =>
          jsonResponse({
            blocks: [],
            cursor: "cur-2",
            caught_up: true,
            next_page_token: null,
          })

        const { result: pollRes, spans } = yield* runWithTestTracer(
          "omnigraph-v014.pollChanges",
          pollOmnigraphChanges({
            branch: OmnigraphBranchName.make("main"),
            cursor: OmnigraphChangeCursor.make("cur-1"),
            fetch: normalFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
          new Map(),
        )
        expect(pollRes.cursor).toBe("cur-2")
        expect(pollRes.requiresBaseline).toBe(false)
        expect(spans.some((s) => s.name === "OmnigraphSync.pollChanges")).toBe(true)

        const gapFetch: FetchLike = (input) => {
          const url = toUrlString(input)
          if (url.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          if (url.includes("/changes/baseline")) {
            return Promise.resolve(
              new Response(
                `${JSON.stringify({ baseline: { snapshot_commit_id: "cmt-snap-1", resume_cursor: "cur-reset-10" } })}\n`,
                {
                  status: 200,
                  headers: { "Content-Type": "application/x-ndjson", "Omnigraph-Http-Api": "0.14" },
                },
              ),
            )
          }
          return jsonResponse(
            {
              code: "change_feed_gap",
              message: "Cursor expired",
              change_feed_gap: { cursor: "cur-1", first_unreadable_commit_id: "cmt-0" },
            },
            410,
          )
        }

        const recovered = yield* pollOmnigraphChanges({
          branch: OmnigraphBranchName.make("main"),
          cursor: OmnigraphChangeCursor.make("cur-1"),
          fetch: gapFetch,
        }).pipe(Effect.provide(OmnigraphSyncLive))

        expect(recovered.requiresBaseline).toBe(true)
        expect(recovered.cursor).toBe("cur-reset-10")
      }),
  )

  it.effect(
    "supports commit proposals (propose/inspect/publish/drop) and Blob operations (put/get/stat)",
    () =>
      Effect.gen(function* () {
        const mockFetch: FetchLike = (input, init) => {
          const url = toUrlString(input)
          const method = init?.method ?? "GET"
          if (url.endsWith("/branches/merge")) {
            return jsonResponse({
              outcome: "merged",
              source: "plan/p1",
              target: "main",
              commit: {
                graph_commit_id: "cmt-prop-1",
                created_at: 1003,
                graph_manifest_version: 1,
                graph_branch: "main",
                parent_commit_id: "cmt-parent-0",
                merged_parent_commit_id: "cmt-plan-0",
                kind: "unpublished",
                published: false,
              },
            })
          }
          if (url.includes("/commits/cmt-prop-1/changes")) {
            return jsonResponse({
              cause: {
                authored_at: 1003,
                authored_branch: "plan/p1",
                graph_commit_id: "cmt-prop-1",
              },
              changes: [],
            })
          }
          if (url.endsWith("/commits/cmt-prop-1/publish")) {
            return jsonResponse({
              graph_commit_id: "cmt-prop-1",
              created_at: 1003,
              graph_manifest_version: 1,
              kind: "published",
            })
          }
          if (url.endsWith("/commits/cmt-prop-1") && method === "DELETE") {
            return Promise.resolve(
              new Response(null, { status: 204, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          if (url.includes("/blob") && method === "PUT") {
            return jsonResponse({
              branch: "main",
              commit: null,
              etag: '"etag-1"',
              kind: "managed",
              selector: {
                entity: "node",
                type: "AdrDoc",
                id: "harness:ADR-0014",
                property: "markdownBlob",
              },
              size: 11,
            })
          }
          if (url.includes("/blob") && method === "GET") {
            return Promise.resolve(
              new Response("# ADR-0014\n", {
                status: 200,
                headers: { "Content-Type": "text/markdown", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }
          if (url.includes("/blob") && method === "HEAD") {
            return Promise.resolve(
              new Response(null, {
                status: 200,
                headers: {
                  etag: '"etag-1"',
                  "content-length": "11",
                  "content-type": "text/markdown",
                  "Omnigraph-Http-Api": "0.14",
                },
              }),
            )
          }
          return jsonResponse({})
        }

        const svc = yield* OmnigraphSync
        const commitId = yield* svc.proposeMergeCommit({
          source: OmnigraphBranchName.make("plan/p1"),
          target: OmnigraphBranchName.make("main"),
          fetch: mockFetch,
        })
        expect(commitId).toBe("cmt-prop-1")

        const changes = yield* svc.inspectCommitChanges({
          commitId: OmnigraphCommitId.make("cmt-prop-1"),
          fetch: mockFetch,
        })
        expect(changes.changes).toEqual([])

        const published = yield* svc.publishCommit({
          commitId: OmnigraphCommitId.make("cmt-prop-1"),
          fetch: mockFetch,
        })
        expect(published.kind).toBe("published")

        yield* svc.dropCommit({
          commitId: OmnigraphCommitId.make("cmt-prop-1"),
          fetch: mockFetch,
        })

        const putRes = yield* svc.putBlob({
          entity: OmnigraphEntityKind.make("node"),
          type: OmnigraphTypeName.make("AdrDoc"),
          id: OmnigraphEntityId.make("harness:ADR-0014"),
          property: "markdownBlob",
          data: "# ADR-0014\n",
          fetch: mockFetch,
        })
        expect(putRes.size).toBe(11)

        const blobText = yield* svc.getBlobText({
          entity: OmnigraphEntityKind.make("node"),
          type: OmnigraphTypeName.make("AdrDoc"),
          id: OmnigraphEntityId.make("harness:ADR-0014"),
          property: "markdownBlob",
          fetch: mockFetch,
        })
        expect(blobText).toBe("# ADR-0014\n")

        const stat = yield* svc.statBlob({
          entity: OmnigraphEntityKind.make("node"),
          type: OmnigraphTypeName.make("AdrDoc"),
          id: OmnigraphEntityId.make("harness:ADR-0014"),
          property: "markdownBlob",
          fetch: mockFetch,
        })
        expect(stat.status).toBe(200)
        expect(stat.etag).toBe('"etag-1"')
        expect(stat.contentLength).toBe(11)
      }).pipe(Effect.provide(OmnigraphSyncLive)),
  )

  it.effect(
    "handles Wave 3 negative paths: proposeMergeCommit 409, inspectCommitChanges non-empty, blob 404/500, stat 500, mutateConditional null actualCommit & 500, pollChanges 410 missing cursor, and actor token loopback guard",
    () =>
      Effect.gen(function* () {
        const svc = yield* OmnigraphSync

        const proposeConflictFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse({ code: "conflict", message: "Merge conflict" }, 409)
        }
        const proposeExit = yield* Effect.exit(
          svc.proposeMergeCommit({
            source: OmnigraphBranchName.make("plan/c1"),
            target: OmnigraphBranchName.make("main"),
            fetch: proposeConflictFetch,
          }),
        )
        match(proposeExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(OmnigraphMergeConflictError)
              })
              .with({ _tag: "None" }, () => expect.fail("Expected OmnigraphMergeConflictError"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected proposeMergeCommit failure"))
          .exhaustive()

        const nonEmptyChangesFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse({
            cause: {
              authored_at: 1005,
              authored_branch: "plan/p1",
              graph_commit_id: "cmt-prop-2",
            },
            changes: [
              {
                entity: "node",
                op: "insert",
                type: { id: "t-1", name: "EffectFn" },
                id: "Sample.ping",
                after: { properties: { isStub: false } },
              },
            ],
          })
        }
        const nonEmptyChanges = yield* svc.inspectCommitChanges({
          commitId: OmnigraphCommitId.make("cmt-prop-2"),
          fetch: nonEmptyChangesFetch,
        })
        expect(nonEmptyChanges.changes).toHaveLength(1)

        const blob404Fetch: FetchLike = (input) => {
          const url = toUrlString(input)
          if (url.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return Promise.resolve(
            new Response("Not Found", { status: 404, headers: { "Omnigraph-Http-Api": "0.14" } }),
          )
        }
        const missingBlob = yield* svc.getBlobText({
          entity: OmnigraphEntityKind.make("node"),
          type: OmnigraphTypeName.make("AdrDoc"),
          id: OmnigraphEntityId.make("harness:ADR-0014"),
          property: "markdownBlob",
          fetch: blob404Fetch,
        })
        expect(missingBlob).toBeNull()

        const err500Fetch: FetchLike = (input) => {
          const url = toUrlString(input)
          if (url.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return Promise.resolve(
            new Response("Server Error", { status: 500, headers: { "Omnigraph-Http-Api": "0.14" } }),
          )
        }
        const blob500Exit = yield* Effect.exit(
          svc.getBlobText({
            entity: OmnigraphEntityKind.make("node"),
            type: OmnigraphTypeName.make("AdrDoc"),
            id: OmnigraphEntityId.make("harness:ADR-0014"),
            property: "markdownBlob",
            fetch: err500Fetch,
          }),
        )
        match(blob500Exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(OmnigraphLoadError)
              })
              .with({ _tag: "None" }, () => expect.fail("Expected OmnigraphLoadError"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected failure"))
          .exhaustive()

        const stat500Exit = yield* Effect.exit(
          svc.statBlob({
            entity: OmnigraphEntityKind.make("node"),
            type: OmnigraphTypeName.make("AdrDoc"),
            id: OmnigraphEntityId.make("harness:ADR-0014"),
            property: "markdownBlob",
            fetch: err500Fetch,
          }),
        )
        match(stat500Exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(OmnigraphLoadError)
              })
              .with({ _tag: "None" }, () => expect.fail("Expected OmnigraphLoadError"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected failure"))
          .exhaustive()

        const mutNullActualFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse(
            {
              code: "precondition_failed",
              message: "Empty head",
              precondition_failure: { expected: "cmt-base-1", actual: null },
            },
            412,
          )
        }
        const mutNullExit = yield* Effect.exit(
          mutateOmnigraphConditional({
            branch: OmnigraphBranchName.make("main"),
            query: "update $fn: EffectFn set { isStub: false }",
            ifGraphCommit: OmnigraphCommitId.make("cmt-base-1"),
            fetch: mutNullActualFetch,
          }),
        )
        match(mutNullExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(OmnigraphPreconditionError)
                if (value instanceof OmnigraphPreconditionError) {
                  expect(value.actualCommit).toBeNull()
                }
              })
              .with({ _tag: "None" }, () => expect.fail("Expected OmnigraphPreconditionError"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected failure"))
          .exhaustive()

        const mut500Exit = yield* Effect.exit(
          mutateOmnigraphConditional({
            branch: OmnigraphBranchName.make("main"),
            query: "update $fn: EffectFn set { isStub: false }",
            ifGraphCommit: OmnigraphCommitId.make("cmt-base-1"),
            fetch: err500Fetch,
          }),
        )
        match(mut500Exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(OmnigraphLoadError)
              })
              .with({ _tag: "None" }, () => expect.fail("Expected OmnigraphLoadError"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected failure"))
          .exhaustive()

        const missingBaselineCursorFetch: FetchLike = (input) => {
          const url = toUrlString(input)
          if (url.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          if (url.includes("/changes/baseline")) {
            return Promise.resolve(
              new Response("", {
                status: 200,
                headers: { "Content-Type": "application/x-ndjson", "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }
          return jsonResponse({ code: "change_feed_gap", message: "Expired" }, 410)
        }
        const pollMissingCursorExit = yield* Effect.exit(
          pollOmnigraphChanges({
            branch: OmnigraphBranchName.make("main"),
            cursor: OmnigraphChangeCursor.make("cur-1"),
            fetch: missingBaselineCursorFetch,
          }),
        )
        match(pollMissingCursorExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(Cause.hasDies(cause)).toBe(false)
            match(Cause.findErrorOption(cause))
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(OmnigraphLoadError)
              })
              .with({ _tag: "None" }, () => expect.fail("Expected OmnigraphLoadError"))
              .exhaustive()
          })
          .with({ _tag: "Success" }, () => expect.fail("Expected failure"))
          .exhaustive()

        const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-tokens-"))
        try {
          const clusterDir = path.join(tmpRepo, ".harness", "omnigraph-cluster")
          fs.mkdirSync(clusterDir, { recursive: true })
          fs.writeFileSync(
            path.join(clusterDir, "auth-tokens.json"),
            JSON.stringify({ cliToken: "cli-secret", mcpToken: "mcp-secret" }),
          )
          fs.writeFileSync(
            path.join(clusterDir, "server.json"),
            JSON.stringify({ baseUrl: "http://127.0.0.1:18999", canonicalRepoRoot: tmpRepo }),
          )

          let seenAuthHeader: string | null = null
          const captureAuthFetch: FetchLike = (input, init) => {
            const url = toUrlString(input)
            if (url.endsWith("/healthz")) {
              return jsonResponse({ status: "ok" })
            }
            seenAuthHeader = new Headers(init?.headers).get("Authorization")
            return jsonResponse({ branches: [] })
          }

          const cliClient = makeOmnigraphClient(
            { repoRoot: tmpRepo, actor: "harness-cli", fetch: captureAuthFetch },
            testHostIo,
            {},
          )
          yield* Effect.tryPromise({
            try: () => cliClient.health(),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          })
          // health() is unauthenticated, test access() or query() for Authorization header
          const mcpClient = makeOmnigraphClient(
            { repoRoot: tmpRepo, actor: "agent-mcp", fetch: captureAuthFetch },
            testHostIo,
            {},
          )
          yield* Effect.tryPromise({
            try: () => mcpClient.branches.list(),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(Effect.orElseSucceed(() => undefined))
          expect(seenAuthHeader).toBe("Bearer mcp-secret")

          seenAuthHeader = null
          const remoteClient = makeOmnigraphClient(
            {
              repoRoot: tmpRepo,
              baseUrl: "https://evil.example.com",
              actor: "harness-cli",
              fetch: captureAuthFetch,
            },
            testHostIo,
            {},
          )
          yield* Effect.tryPromise({
            try: () => remoteClient.branches.list(),
            catch: (cause) => new OmnigraphLoadError({ cause }),
          }).pipe(Effect.orElseSucceed(() => undefined))
          expect(seenAuthHeader).toBeNull()
        } finally {
          fs.rmSync(tmpRepo, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(OmnigraphSyncLive)),
  )

  const PropDryRunCase = Schema.Struct({
    source: OmnigraphBranchName,
    target: OmnigraphBranchName,
    hasConflict: Schema.Boolean,
  })

  it.effect.prop(
    "property: dryRunMergeOmnigraphBranches preserves source/target and maps 409 conflicts uniformly",
    [PropDryRunCase],
    ([spec]) =>
      Effect.gen(function* () {
        const mockFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return spec.hasConflict
            ? jsonResponse(
                {
                  code: "conflict",
                  message: "Conflict",
                  merge_conflicts: [
                    {
                      kind: "divergent_update",
                      entity_kind: "node",
                      type_name: "EffectFn",
                      entity_id: "fn.a",
                      message: "conflict",
                    },
                  ],
                },
                409,
              )
            : jsonResponse({
                outcome: "fast_forward",
                source: spec.source,
                target: spec.target,
                dry_run: true,
                commit: null,
              })
        }

        const exit = yield* Effect.exit(
          dryRunMergeOmnigraphBranches({
            source: spec.source,
            target: spec.target,
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )

        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            expect(spec.hasConflict).toBe(true)
            expect(Cause.hasFails(cause)).toBe(true)
            expect(Cause.hasDies(cause)).toBe(false)
          })
          .with({ _tag: "Success" }, ({ value }) => {
            expect(spec.hasConflict).toBe(false)
            expect(value.source).toBe(spec.source)
            expect(value.target).toBe(spec.target)
          })
          .exhaustive()
      }),
  )
})
