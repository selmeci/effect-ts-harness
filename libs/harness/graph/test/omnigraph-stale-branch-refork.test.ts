import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { WorkspaceFilePath } from "@harness/contract"
import { Cause, Effect } from "effect"
import { type FetchLike, Omnigraph } from "@modernrelay/omnigraph"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  makeOmnigraphSyncLayer,
  PackageTag,
  readGraphHeadMeta,
  syncToOmnigraphAndSnapshot,
} from "../src/index.js"
import { executeLoadWithStaleRefork, OmnigraphLoadError } from "../src/omnigraph-v014-ops.js"
import { testHostIo } from "./helpers/test-host-io.js"

const OmnigraphSyncLive = makeOmnigraphSyncLayer(testHostIo)

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: Record<string, unknown> | undefined
}

const jsonResponse = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Omnigraph-Http-Api": "0.14",
      },
    }),
  )

const toUrlString = (input: Parameters<FetchLike>[0]): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

const sampleGraph = buildHarnessGraph({
  fns: [
    {
      qualname: "libs/sample/src/fn.ts#Sample.staleRefork",
      spanName: "Sample.staleRefork",
      packageTag: PackageTag.make("domain"),
      file: WorkspaceFilePath.make("libs/sample/src/fn.ts"),
      line: 12,
      isStub: false,
    },
  ],
})

const makeTempGitRepo = (prefix: string): string => {
  const repoDir = fs.mkdtempSync(path.join(tmpdir(), prefix))
  fs.mkdirSync(path.join(repoDir, ".git", "refs", "heads", "feat"), { recursive: true })
  fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/feat/stale-refork\n")
  fs.writeFileSync(
    path.join(repoDir, ".git", "refs", "heads", "feat", "stale-refork"),
    "abcdef1234567890abcdef1234567890abcdef12\n",
  )
  return repoDir
}

const makeCommitPayload = (graphCommitId: string, branch: string) => ({
  graph_commit_id: graphCommitId,
  created_at: 1000,
  graph_manifest_version: 1,
  graph_branch: branch,
  kind: "published",
})

const makeLoadPayload = (
  branch: string,
  branchCreated: boolean,
  commitId: string,
  mode: string,
) => ({
  branch,
  branch_created: branchCreated,
  commit: makeCommitPayload(commitId, branch),
  edges: [],
  embedding_generation: null,
  mode,
  nodes: [],
  total_entities: 1,
  uri: `/graphs/harness/branches/${encodeURIComponent(branch)}`,
})

describe("OmnigraphSync stale diverged worktree branch self-healing (SPEC-0014 REQ-1.3 / REQ-1.4)", () => {
  it.effect(
    "fresh branch (branch_created=true) performs 1 load with 0 merge-base/dryRun/delete requests",
    () =>
      Effect.gen(function* () {
        const repoDir = makeTempGitRepo("og-refork-fresh-")
        try {
          const requests: Array<RecordedRequest> = []
          const mockFetch: FetchLike = (input, init) => {
            const url = toUrlString(input)
            const method = init?.method ?? "GET"
            const body =
              typeof init?.body === "string"
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : undefined
            requests.push({ method, url, body })

            if (url.endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            if (url.endsWith("/load")) {
              return jsonResponse(
                makeLoadPayload("plan/wt-fresh", true, "cmt-fresh-1", "overwrite"),
              )
            }
            return jsonResponse({ code: "not_found", message: "Unexpected endpoint" }, 404)
          }

          const snapshotPath = path.join(repoDir, ".harness", "graph-snapshot.json")
          const res = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: "plan/wt-fresh",
            from: "main",
            snapshotPath,
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(res.syncedToOmnigraph).toBe(true)
          expect(res.commitId).toBe("cmt-fresh-1")
          expect(requests.filter((r) => r.url.endsWith("/load"))).toHaveLength(1)
          expect(requests.some((r) => r.url.includes("/branches/merge-base"))).toBe(false)
          expect(requests.some((r) => r.url.endsWith("/branches/merge"))).toBe(false)
          expect(requests.some((r) => r.method === "DELETE")).toBe(false)
          expect(readGraphHeadMeta(repoDir, testHostIo)?.omnigraphCommitId).toBe("cmt-fresh-1")
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "up-to-date existing branch (merge_base === target_commit_id) preserves branch without dryRun merge or DELETE",
    () =>
      Effect.gen(function* () {
        const repoDir = makeTempGitRepo("og-refork-uptodate-")
        try {
          const requests: Array<RecordedRequest> = []
          const mockFetch: FetchLike = (input, init) => {
            const url = toUrlString(input)
            const method = init?.method ?? "GET"
            const body =
              typeof init?.body === "string"
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : undefined
            requests.push({ method, url, body })

            if (url.endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            if (url.endsWith("/load")) {
              return jsonResponse(
                makeLoadPayload("impl/wt-uptodate", false, "cmt-uptodate-1", "overwrite"),
              )
            }
            if (url.includes("/branches/merge-base")) {
              return jsonResponse({
                merge_base: makeCommitPayload("cmt-main-head", "main"),
                source: "impl/wt-uptodate",
                source_commit_id: "cmt-uptodate-1",
                target: "main",
                target_commit_id: "cmt-main-head",
              })
            }
            return jsonResponse({ code: "internal", message: "Should not be called" }, 500)
          }

          const res = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: "impl/wt-uptodate",
            from: "main",
            snapshotPath: path.join(repoDir, ".harness", "graph-snapshot.json"),
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(res.syncedToOmnigraph).toBe(true)
          expect(res.commitId).toBe("cmt-uptodate-1")
          expect(requests.filter((r) => r.url.endsWith("/load"))).toHaveLength(1)
          expect(requests.filter((r) => r.url.includes("/branches/merge-base"))).toHaveLength(1)
          expect(requests.some((r) => r.url.endsWith("/branches/merge"))).toBe(false)
          expect(requests.some((r) => r.method === "DELETE")).toBe(false)
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "concurrent non-conflicting branch (merge_base !== target_commit_id, dryRun merge 200) keeps branch without DELETE",
    () =>
      Effect.gen(function* () {
        const repoDir = makeTempGitRepo("og-refork-nonconflict-")
        try {
          const requests: Array<RecordedRequest> = []
          const mockFetch: FetchLike = (input, init) => {
            const url = toUrlString(input)
            const method = init?.method ?? "GET"
            const body =
              typeof init?.body === "string"
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : undefined
            requests.push({ method, url, body })

            if (url.endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            if (url.endsWith("/load")) {
              return jsonResponse(
                makeLoadPayload("impl/wt-concurrent", false, "cmt-conc-1", "overwrite"),
              )
            }
            if (url.includes("/branches/merge-base")) {
              return jsonResponse({
                merge_base: makeCommitPayload("cmt-ancestor-0", "main"),
                source: "impl/wt-concurrent",
                source_commit_id: "cmt-conc-1",
                target: "main",
                target_commit_id: "cmt-main-newer",
              })
            }
            if (url.endsWith("/branches/merge")) {
              if (body?.["dry_run"] !== true) {
                return jsonResponse({ code: "bad_request", message: "Expected dry_run: true" }, 500)
              }
              return jsonResponse({
                outcome: "merged",
                source: "impl/wt-concurrent",
                target: "main",
                dry_run: true,
                commit: null,
              })
            }
            return jsonResponse({ code: "internal", message: "Unexpected DELETE" }, 500)
          }

          const res = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: "impl/wt-concurrent",
            from: "main",
            snapshotPath: path.join(repoDir, ".harness", "graph-snapshot.json"),
            fetch: mockFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(res.syncedToOmnigraph).toBe(true)
          expect(res.commitId).toBe("cmt-conc-1")
          const mergeReq = requests.find((r) => r.url.endsWith("/branches/merge"))
          expect(mergeReq?.body?.["dry_run"]).toBe(true)
          expect(requests.some((r) => r.method === "DELETE")).toBe(false)
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "stale conflicted worktree branches (impl/wt-stale & plan/wt-stale) delete and reload from main",
    () =>
      Effect.gen(function* () {
        for (const branchName of ["impl/wt-stale", "plan/wt-stale"] as const) {
          const repoDir = makeTempGitRepo("og-refork-stale-")
          try {
            const requests: Array<RecordedRequest> = []
            let loadCount = 0
            let deleted = false
            const mockFetch: FetchLike = (input, init) => {
              const url = toUrlString(input)
              const method = init?.method ?? "GET"
              const body =
                typeof init?.body === "string"
                  ? (JSON.parse(init.body) as Record<string, unknown>)
                  : undefined
              requests.push({ method, url, body })

              if (url.endsWith("/healthz")) {
                return Promise.resolve(
                  new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
                )
              }
              if (url.endsWith("/load")) {
                loadCount += 1
                if (!deleted) {
                  return jsonResponse(
                    makeLoadPayload(branchName, false, "cmt-stale-1", "overwrite"),
                  )
                }
                return jsonResponse(
                  makeLoadPayload(branchName, true, "cmt-reforked-2", "overwrite"),
                )
              }
              if (url.includes("/branches/merge-base")) {
                return jsonResponse({
                  merge_base: makeCommitPayload("cmt-root-0", "main"),
                  source: branchName,
                  source_commit_id: "cmt-stale-1",
                  target: "main",
                  target_commit_id: "cmt-main-5",
                })
              }
              if (url.endsWith("/branches/merge")) {
                if (body?.["dry_run"] !== true) {
                  return jsonResponse(
                    { code: "bad_request", message: "Expected dry_run: true" },
                    500,
                  )
                }
                return jsonResponse(
                  {
                    code: "conflict",
                    message: "divergent_insert",
                    merge_conflicts: [
                      {
                        kind: "divergent_insert",
                        entity_kind: "node",
                        type_name: "EffectFn",
                        entity_id: "Sample.staleRefork",
                        message: "divergent insert",
                      },
                    ],
                  },
                  409,
                )
              }
              if (
                method === "DELETE" &&
                url.includes(`/branches/${encodeURIComponent(branchName)}`)
              ) {
                deleted = true
                return jsonResponse({ name: branchName, uri: url })
              }
              return jsonResponse({ code: "not_found", message: "Unexpected" }, 404)
            }

            const res = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
              repoRoot: repoDir,
              branch: branchName,
              from: "main",
              snapshotPath: path.join(repoDir, ".harness", "graph-snapshot.json"),
              fetch: mockFetch,
            }).pipe(Effect.provide(OmnigraphSyncLive))

            expect(res.syncedToOmnigraph).toBe(true)
            expect(res.commitId).toBe("cmt-reforked-2")
            expect(loadCount).toBe(2)
            const deleteReqs = requests.filter((r) => r.method === "DELETE")
            expect(deleteReqs).toHaveLength(1)
            expect(deleteReqs[0]?.url).toContain(encodeURIComponent(branchName))
            const secondLoad = requests.filter((r) => r.url.endsWith("/load"))[1]
            expect(secondLoad?.body?.["from"]).toBe("main")
            expect(secondLoad?.body?.["mode"]).toBe("overwrite")
            expect(readGraphHeadMeta(repoDir, testHostIo)?.omnigraphCommitId).toBe("cmt-reforked-2")
          } finally {
            fs.rmSync(repoDir, { recursive: true, force: true })
          }
        }
      }),
  )

  it.effect(
    "tolerates NotFoundError (404) on DELETE during stale branch re-fork and completes second load",
    () =>
      Effect.gen(function* () {
        let deletedAttempted = false
        let loadCount = 0
        const mockFetch: FetchLike = (input, init) => {
          const url = toUrlString(input)
          const method = init?.method ?? "GET"
          if (url.endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          if (url.endsWith("/load")) {
            loadCount += 1
            return jsonResponse(
              makeLoadPayload(
                "impl/wt-raced",
                deletedAttempted,
                deletedAttempted ? "cmt-reforked-404" : "cmt-initial-404",
                "overwrite",
              ),
            )
          }
          if (url.includes("/branches/merge-base")) {
            return jsonResponse({
              merge_base: makeCommitPayload("cmt-root-0", "main"),
              source: "impl/wt-raced",
              source_commit_id: "cmt-initial-404",
              target: "main",
              target_commit_id: "cmt-main-9",
            })
          }
          if (url.endsWith("/branches/merge")) {
            return jsonResponse(
              {
                code: "conflict",
                message: "conflict",
                merge_conflicts: [
                  {
                    kind: "divergent_update",
                    entity_kind: "node",
                    type_name: "EffectFn",
                    entity_id: "fn-1",
                    message: "conflict",
                  },
                ],
              },
              409,
            )
          }
          if (method === "DELETE") {
            deletedAttempted = true
            return jsonResponse({ code: "not_found", message: "Already deleted" }, 404)
          }
          return jsonResponse({}, 500)
        }

        const og = new Omnigraph({
          baseUrl: "http://127.0.0.1:18080",
          graphId: "harness",
          fetch: mockFetch,
        })
        const res = yield* executeLoadWithStaleRefork(og, {
          branch: "impl/wt-raced",
          from: "main",
          mode: "overwrite",
          data: '{"type":"EffectFn","id":"fn-1","data":{}}',
        })

        expect(deletedAttempted).toBe(true)
        expect(loadCount).toBe(2)
        expect(res.commit?.graphCommitId).toBe("cmt-reforked-404")
      }),
  )

  it.effect(
    "guards (main branch, append/merge modes, undefined/self from) never probe merge-base or delete",
    () =>
      Effect.gen(function* () {
        const repoDir = makeTempGitRepo("og-refork-guards-")
        try {
          const syncMainRequests: Array<RecordedRequest> = []
          const mainSyncFetch: FetchLike = (input, init) => {
            const url = toUrlString(input)
            const method = init?.method ?? "GET"
            const body =
              typeof init?.body === "string"
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : undefined
            syncMainRequests.push({ method, url, body })
            if (url.endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            if (url.endsWith("/load")) {
              return jsonResponse(makeLoadPayload("main", false, "cmt-main-only", "merge"))
            }
            return jsonResponse({ code: "internal", message: "Unexpected endpoint" }, 500)
          }

          const syncMainRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: repoDir,
            branch: "main",
            snapshotPath: path.join(repoDir, ".harness", "graph-snapshot.json"),
            fetch: mainSyncFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(syncMainRes.syncedToOmnigraph).toBe(true)
          const mainLoadBody = syncMainRequests.find((r) => r.url.endsWith("/load"))?.body ?? {}
          expect("from" in mainLoadBody).toBe(false)
          expect(syncMainRequests.some((r) => r.url.includes("/branches/merge-base"))).toBe(false)

          const guardCases: ReadonlyArray<{
            readonly branch: string
            readonly from: string | undefined
            readonly mode: "overwrite" | "append" | "merge"
          }> = [
            { branch: "main", from: "other", mode: "overwrite" },
            { branch: "impl/wt-mode", from: "main", mode: "merge" },
            { branch: "impl/wt-mode", from: "main", mode: "append" },
            { branch: "impl/wt-nofrom", from: undefined, mode: "overwrite" },
            { branch: "impl/self", from: "impl/self", mode: "overwrite" },
          ]

          for (const gCase of guardCases) {
            const recorded: Array<RecordedRequest> = []
            const guardFetch: FetchLike = (input, init) => {
              const url = toUrlString(input)
              const method = init?.method ?? "GET"
              recorded.push({ method, url, body: undefined })
              if (url.endsWith("/healthz")) {
                return Promise.resolve(
                  new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
                )
              }
              if (url.endsWith("/load")) {
                return jsonResponse(makeLoadPayload(gCase.branch, false, "cmt-guard", gCase.mode))
              }
              return jsonResponse({ code: "internal", message: "Should not be called" }, 500)
            }
            const og = new Omnigraph({
              baseUrl: "http://127.0.0.1:18080",
              graphId: "harness",
              fetch: guardFetch,
            })
            const out = yield* executeLoadWithStaleRefork(og, {
              branch: gCase.branch,
              ...(gCase.from !== undefined ? { from: gCase.from } : {}),
              mode: gCase.mode,
              data: '{"type":"EffectFn","id":"fn-g","data":{}}',
            })
            expect(out.commit?.graphCommitId).toBe("cmt-guard")
            expect(recorded.filter((r) => r.url.endsWith("/load"))).toHaveLength(1)
            expect(recorded.some((r) => r.url.includes("/branches/merge-base"))).toBe(false)
            expect(recorded.some((r) => r.method === "DELETE")).toBe(false)
          }
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "fails closed with OmnigraphLoadError on HTTP 500 across merge-base, dryRun merge, DELETE, and reload",
    () =>
      Effect.gen(function* () {
        const repoDir = makeTempGitRepo("og-refork-failclosed-")
        try {
          const failureStages = ["merge-base", "dry-run-merge", "delete", "reload"] as const
          for (const stage of failureStages) {
            const recorded: Array<RecordedRequest> = []
            let loadCount = 0
            const stageFetch: FetchLike = (input, init) => {
              const url = toUrlString(input)
              const method = init?.method ?? "GET"
              recorded.push({ method, url, body: undefined })

              if (url.endsWith("/healthz")) {
                return Promise.resolve(
                  new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
                )
              }
              if (url.endsWith("/load")) {
                loadCount += 1
                if (stage === "reload" && loadCount === 2) {
                  return jsonResponse({ code: "internal", message: "Reload failed 500" }, 500)
                }
                return jsonResponse(makeLoadPayload("impl/wt-fail", false, "cmt-f1", "overwrite"))
              }
              if (url.includes("/branches/merge-base")) {
                if (stage === "merge-base") {
                  return jsonResponse({ code: "internal", message: "merge-base 500" }, 500)
                }
                return jsonResponse({
                  merge_base: makeCommitPayload("cmt-root-0", "main"),
                  source: "impl/wt-fail",
                  source_commit_id: "cmt-f1",
                  target: "main",
                  target_commit_id: "cmt-main-9",
                })
              }
              if (url.endsWith("/branches/merge")) {
                if (stage === "dry-run-merge") {
                  return jsonResponse({ code: "internal", message: "dryRun merge 500" }, 500)
                }
                return jsonResponse(
                  {
                    code: "conflict",
                    message: "divergent_insert",
                    merge_conflicts: [
                      {
                        kind: "divergent_insert",
                        entity_kind: "node",
                        type_name: "EffectFn",
                        entity_id: "fn-1",
                        message: "divergent_insert",
                      },
                    ],
                  },
                  409,
                )
              }
              if (method === "DELETE") {
                if (stage === "delete") {
                  return jsonResponse({ code: "internal", message: "DELETE 500" }, 500)
                }
                return jsonResponse({ name: "impl/wt-fail", uri: url })
              }
              return jsonResponse({}, 404)
            }

            const og = new Omnigraph({
              baseUrl: "http://127.0.0.1:18080",
              graphId: "harness",
              fetch: stageFetch,
            })
            const directRes = yield* Effect.exit(
              executeLoadWithStaleRefork(og, {
                branch: "impl/wt-fail",
                from: "main",
                mode: "overwrite",
                data: '{"type":"EffectFn","id":"fn-1","data":{}}',
              }),
            )
            match(directRes)
              .with({ _tag: "Failure" }, ({ cause }) => {
                match(Cause.findErrorOption(cause))
                  .with({ _tag: "Some" }, ({ value: err }) => {
                    expect(err).toBeInstanceOf(OmnigraphLoadError)
                  })
                  .with({ _tag: "None" }, () => {
                    expect.fail(`Expected OmnigraphLoadError, got ${Cause.pretty(cause)}`)
                  })
                  .exhaustive()
              })
              .with({ _tag: "Success" }, () => {
                expect.fail("Expected OmnigraphLoadError failure")
              })
              .exhaustive()

            match(stage)
              .with("merge-base", "dry-run-merge", () => {
                expect(recorded.some((r) => r.method === "DELETE")).toBe(false)
              })
              .with("delete", () => {
                expect(loadCount).toBe(1)
              })
              .with("reload", () => {
                expect(loadCount).toBe(2)
              })
              .exhaustive()

            loadCount = 0
            const syncRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
              repoRoot: repoDir,
              branch: "impl/wt-fail",
              from: "main",
              snapshotPath: path.join(repoDir, ".harness", `snapshot-${stage}.json`),
              fetch: stageFetch,
            }).pipe(Effect.provide(OmnigraphSyncLive))
            expect(syncRes.syncedToOmnigraph).toBe(false)
            expect(syncRes.error).toBeDefined()
          }
        } finally {
          fs.rmSync(repoDir, { recursive: true, force: true })
        }
      }),
  )
})
