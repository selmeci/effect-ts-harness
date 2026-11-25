import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import {
  OmnigraphBranchName,
  OmnigraphChangeCursor,
  OmnigraphCommitId,
  OmnigraphMergeConflictError,
} from "@harness/contract"
import { Effect } from "effect"
import * as Graph from "effect/Graph"
import { type FetchLike } from "@modernrelay/omnigraph"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  dryRunMergeOmnigraphBranches,
  makeOmnigraphClient,
  makeOmnigraphSyncLayer,
  mergeOmnigraphBranch,
  mutateOmnigraphConditional,
  NodeKey,
  OmnigraphLoadError,
  OmnigraphSync,
  pollOmnigraphChanges,
  readAuthTokensFromClusterDir,
  readGraphHeadMeta,
  readGraphHeadMetaState,
  RelationId,
  resolveOmnigraphBaseUrl,
  RoleName,
  syncToOmnigraphAndSnapshot,
  toOmnigraphServerNdjson,
  updateGraphHeadCursor,
  writeGraphHeadMeta,
} from "../src/index.js"
import { withGraphHeadLock } from "../src/cluster-resolver.js"
import { extendedTestHostIo, makeExtendedTestHostIo, testHostIo } from "./helpers/test-host-io.js"
import {
  OmnigraphSyncLive,
  jsonResponse,
  sampleGraph,
  toUrlString,
} from "./helpers/omnigraph-v014-fixture.js"

describe("Omnigraph v0.14.0 cursor, env, auth & merge hardening (RFC-0009)", () => {
  it("F-1.1a: updateGraphHeadCursor preserves null or prior headSha/gitBranch without reading git HEAD", () => {
    const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-cursor-only-"))
    try {
      const gitDir = path.join(tmpRepo, ".git", "refs", "heads")
      fs.mkdirSync(gitDir, { recursive: true })
      fs.writeFileSync(path.join(tmpRepo, ".git", "HEAD"), "ref: refs/heads/feat/live\n")
      fs.mkdirSync(path.join(tmpRepo, ".git", "refs", "heads", "feat"), { recursive: true })
      fs.writeFileSync(
        path.join(tmpRepo, ".git", "refs", "heads", "feat", "live"),
        "live-head-sha-999",
      )

      // 1. When prior graph-head.json is missing, headSha and gitBranch remain null
      const created = updateGraphHeadCursor(
        tmpRepo,
        testHostIo,
        OmnigraphChangeCursor.make("cur-1"),
        {},
      )
      expect(created).not.toBeNull()
      expect(created?.headSha).toBeNull()
      expect(created?.gitBranch).toBeNull()
      expect(created?.changeFeedCursor).toBe("cur-1")

      // 2. When prior graph-head.json has a different SHA/branch, it is preserved verbatim
      writeGraphHeadMeta(
        tmpRepo,
        testHostIo,
        {
          headSha: "prior-sync-sha-111",
          gitBranch: "main",
          omnigraphCommitId: OmnigraphCommitId.make("cmt-10"),
        },
        {},
      )
      const updated = updateGraphHeadCursor(
        tmpRepo,
        testHostIo,
        OmnigraphChangeCursor.make("cur-2"),
        {},
      )
      expect(updated?.headSha).toBe("prior-sync-sha-111")
      expect(updated?.gitBranch).toBe("main")
      expect(updated?.omnigraphCommitId).toBe("cmt-10")
      expect(updated?.changeFeedCursor).toBe("cur-2")
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it.effect(
    "F-3.1: OmnigraphSync honors OMNIGRAPH_URL and OMNIGRAPH_TOKEN from layer env and options.env",
    () =>
      Effect.gen(function* () {
        const seenUrls: Array<string> = []
        const seenAuths: Array<string | null> = []
        const captureFetch: FetchLike = (input, init) => {
          seenUrls.push(toUrlString(input))
          seenAuths.push(new Headers(init?.headers).get("Authorization"))
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse({ rows: [] })
        }

        const layerFromEnv = makeOmnigraphSyncLayer(testHostIo, {
          OMNIGRAPH_URL: "http://127.0.0.1:19111",
          OMNIGRAPH_TOKEN: "layer-tok",
        })
        yield* Effect.flatMap(OmnigraphSync, (s) =>
          s.query({ query: "MATCH (n) RETURN n", fetch: captureFetch }),
        ).pipe(Effect.provide(layerFromEnv))

        expect(seenUrls.some((u) => u.startsWith("http://127.0.0.1:19111"))).toBe(true)
        expect(seenAuths.some((a) => a === "Bearer layer-tok")).toBe(true)

        seenUrls.length = 0
        seenAuths.length = 0
        yield* Effect.flatMap(OmnigraphSync, (s) =>
          s.query({
            query: "MATCH (n) RETURN n",
            fetch: captureFetch,
            env: {
              OMNIGRAPH_URL: "http://127.0.0.1:19222",
              OMNIGRAPH_TOKEN: "opt-tok",
            },
          }),
        ).pipe(Effect.provide(layerFromEnv))

        expect(seenUrls.some((u) => u.startsWith("http://127.0.0.1:19222"))).toBe(true)
        expect(seenAuths.some((a) => a === "Bearer opt-tok")).toBe(true)
      }),
  )

  it("F-4.1: writeGraphHeadMeta returns null and logs to stderr when writeTextSync throws", () => {
    const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-write-fail-"))
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const failingIo = {
        ...testHostIo,
        writeTextSync: () => {
          throw new Error("EACCES: permission denied")
        },
      }
      const res = writeGraphHeadMeta(tmpRepo, failingIo, {
        headSha: "sha-1",
        gitBranch: "main",
      })
      expect(res).toBeNull()
      expect(stderrChunks.join("")).toContain("failed to persist")
    } finally {
      process.stderr.write = origWrite
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it("F-5.1: readGraphHeadMeta returns null and logs warning to stderr on corrupt JSON", () => {
    const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-corrupt-meta-"))
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const harnessDir = path.join(tmpRepo, ".harness")
      fs.mkdirSync(harnessDir, { recursive: true })
      fs.writeFileSync(path.join(harnessDir, "graph-head.json"), "{not-valid-json")

      const res = readGraphHeadMeta(tmpRepo, testHostIo, {})
      expect(res).toBeNull()
      expect(stderrChunks.join("")).toContain("failed to decode")
    } finally {
      process.stderr.write = origWrite
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it.effect(
    "F-11.2: empty graph syncToOmnigraphAndSnapshot returns syncedToOmnigraph=false without writing graph-head.json",
    () =>
      Effect.gen(function* () {
        const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-empty-sync-"))
        try {
          const emptyGraph = buildHarnessGraph({})
          const snapshotPath = path.join(tmpRepo, ".harness", "graph-snapshot.json")
          const res = yield* syncToOmnigraphAndSnapshot(emptyGraph, {
            repoRoot: tmpRepo,
            snapshotPath,
            fetch: () => Promise.reject(new Error("should not call fetch for empty graph")),
          }).pipe(Effect.provide(OmnigraphSyncLive))

          expect(res.syncedToOmnigraph).toBe(false)
          expect(res.error).toContain("Cannot sync empty graph payload (0 entities)")
          expect(fs.existsSync(path.join(tmpRepo, ".harness", "graph-head.json"))).toBe(false)
        } finally {
          fs.rmSync(tmpRepo, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "F-15.7: rejects malformed non-null entityId/commitId strings with OmnigraphLoadError instead of null coercion",
    () =>
      Effect.gen(function* () {
        const source = OmnigraphBranchName.make("impl/task")
        const target = OmnigraphBranchName.make("main")

        const badConflictFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse(
            {
              code: "conflict",
              message: "Conflict",
              merge_conflicts: [
                {
                  kind: "divergent_update",
                  entity_kind: "node",
                  type_name: "EffectFn",
                  entity_id: "   ",
                  message: "bad entity id",
                },
              ],
            },
            409,
          )
        }
        const mappedConflict = yield* Effect.flip(
          dryRunMergeOmnigraphBranches({ source, target, fetch: badConflictFetch }).pipe(
            Effect.provide(OmnigraphSyncLive),
          ),
        )
        expect(mappedConflict).toBeInstanceOf(OmnigraphLoadError)

        const badPrecondFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse(
            {
              code: "precondition_failed",
              message: "Precondition failed",
              precondition_failure: {
                expected: "cmt-1",
                actual: "   ",
              },
            },
            412,
          )
        }
        const mappedPrecond = yield* Effect.flip(
          mutateOmnigraphConditional({
            branch: target,
            query: "CREATE (n:EffectFn { qualname: 'x' })",
            ifGraphCommit: OmnigraphCommitId.make("cmt-1"),
            fetch: badPrecondFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )
        expect(mappedPrecond).toBeInstanceOf(OmnigraphLoadError)

        const badCommitFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse({
            outcome: "fast_forward",
            source: "impl/task",
            target: "main",
            commit: { graph_commit_id: "   " },
          })
        }
        const proposeErr = yield* Effect.flip(
          Effect.flatMap(OmnigraphSync, (s) =>
            s.proposeMergeCommit({ source, target, fetch: badCommitFetch }),
          ).pipe(Effect.provide(OmnigraphSyncLive)),
        )
        expect(proposeErr).toBeInstanceOf(OmnigraphLoadError)
      }),
  )

  it.effect(
    "F-17.1b: sync handles /load HTTP 500 failure and writeGraphHeadMeta merges partial metadata preserving headSha",
    () =>
      Effect.gen(function* () {
        const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-sync500-merge-"))
        try {
          const snapshotPath = path.join(tmpRepo, ".harness", "graph-snapshot.json")
          const fail500Fetch: FetchLike = (input) => {
            if (toUrlString(input).endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            return Promise.resolve(
              new Response("internal server error", {
                status: 500,
                headers: { "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }
          const syncRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: tmpRepo,
            snapshotPath,
            fetch: fail500Fetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(syncRes.syncedToOmnigraph).toBe(false)
          expect(syncRes.error).toContain("500")

          writeGraphHeadMeta(
            tmpRepo,
            testHostIo,
            {
              headSha: "sha-base-1",
              gitBranch: "main",
              omnigraphCommitId: OmnigraphCommitId.make("cmt-base-1"),
            },
            {},
          )
          writeGraphHeadMeta(
            tmpRepo,
            testHostIo,
            { headSha: "sha-base-1", gitBranch: "main" },
            {},
            { changeFeedCursor: OmnigraphChangeCursor.make("cur-merged-1") },
          )
          const merged = readGraphHeadMeta(tmpRepo, testHostIo, {})
          expect(merged?.headSha).toBe("sha-base-1")
          expect(merged?.omnigraphCommitId).toBe("cmt-base-1")
          expect(merged?.changeFeedCursor).toBe("cur-merged-1")
        } finally {
          fs.rmSync(tmpRepo, { recursive: true, force: true })
        }
      }),
  )

  it("R2-P1: resolveOmnigraphBaseUrl and makeOmnigraphClient read explicit env or hostIo.getEnv() while omitted args and {} isolate", async () => {
    const prevUrl = process.env["OMNIGRAPH_URL"]
    const prevTok = process.env["OMNIGRAPH_TOKEN"]
    try {
      process.env["OMNIGRAPH_URL"] = "http://127.0.0.1:19444"
      process.env["OMNIGRAPH_TOKEN"] = "env-default-token"

      expect(resolveOmnigraphBaseUrl(undefined, process.env)).toBe("http://127.0.0.1:19444")
      expect(resolveOmnigraphBaseUrl(undefined, undefined, testHostIo)).toBe(
        "http://127.0.0.1:19444",
      )
      expect(resolveOmnigraphBaseUrl()).toBe("http://127.0.0.1:8080")
      expect(resolveOmnigraphBaseUrl(undefined, {})).toBe("http://127.0.0.1:8080")

      let seenUrl = ""
      let seenAuth: string | null = null
      const captureFetch: FetchLike = (input, init) => {
        const url = toUrlString(input)
        seenUrl = url
        const headers = new Headers(
          init?.headers ??
            (typeof input === "object" && "headers" in input ? input.headers : undefined),
        )
        seenAuth = headers.get("authorization")
        if (url.endsWith("/healthz")) {
          return Promise.resolve(
            new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
          )
        }
        return jsonResponse({ branches: ["main"] })
      }
      const client = makeOmnigraphClient({ fetch: captureFetch }, testHostIo)
      await client.branches.list()
      expect(seenUrl.startsWith("http://127.0.0.1:19444/")).toBe(true)
      expect(seenAuth).toBe("Bearer env-default-token")
    } finally {
      if (prevUrl === undefined) {
        delete process.env["OMNIGRAPH_URL"]
      } else {
        process.env["OMNIGRAPH_URL"] = prevUrl
      }
      if (prevTok === undefined) {
        delete process.env["OMNIGRAPH_TOKEN"]
      } else {
        process.env["OMNIGRAPH_TOKEN"] = prevTok
      }
    }
  })

  it("R2-P3: readGraphHeadMetaState distinguishes Present/Missing/Corrupt and updateGraphHeadCursor refuses corrupt overwrite", () => {
    const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-r2p3-"))
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      expect(readGraphHeadMetaState(tmpRepo, testHostIo, {})).toEqual({ _tag: "Missing" })
      expect(
        match(readGraphHeadMetaState(tmpRepo, testHostIo, { HARNESS_STATE_DIR: "." }))
          .with({ _tag: "Corrupt" }, ({ reason }) =>
            reason.includes("must not resolve to workspaceRoot"),
          )
          .with({ _tag: "Present" }, { _tag: "Missing" }, () => false)
          .exhaustive(),
      ).toBe(true)
      expect(
        readGraphHeadMetaState(tmpRepo, testHostIo, {
          HARNESS_STATE_DIR: path.join(tmpRepo, ".custom-state"),
        }),
      ).toEqual({ _tag: "Missing" })

      const metaPath = path.join(tmpRepo, ".harness", "graph-head.json")
      fs.mkdirSync(path.dirname(metaPath), { recursive: true })
      fs.writeFileSync(metaPath, "{corrupt-meta", "utf8")

      const corruptState = readGraphHeadMetaState(tmpRepo, testHostIo, {})
      match(corruptState)
        .with({ _tag: "Corrupt" }, ({ path: corruptPath }) => {
          expect(corruptPath).toBe(metaPath)
        })
        .with({ _tag: "Present" }, () => expect.fail("Expected Corrupt state"))
        .with({ _tag: "Missing" }, () => expect.fail("Expected Corrupt state"))
        .exhaustive()

      const cursorRes = updateGraphHeadCursor(
        tmpRepo,
        testHostIo,
        OmnigraphChangeCursor.make("cur-should-not-write"),
        {},
      )
      expect(cursorRes).toBeNull()
      expect(fs.readFileSync(metaPath, "utf8")).toBe("{corrupt-meta")
      expect(stderrChunks.join("")).toContain("refusing cursor update on corrupt")

      writeGraphHeadMeta(tmpRepo, testHostIo, { headSha: "sha-ok", gitBranch: "main" }, {})
      const presentState = readGraphHeadMetaState(tmpRepo, testHostIo, {})
      match(presentState)
        .with({ _tag: "Present" }, ({ meta }) => {
          expect(meta.headSha).toBe("sha-ok")
        })
        .with({ _tag: "Missing" }, () => expect.fail("Expected Present state"))
        .with({ _tag: "Corrupt" }, () => expect.fail("Expected Present state"))
        .exhaustive()
    } finally {
      process.stderr.write = origWrite
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it("R2-I3a: logs stderr warnings on corrupt auth-tokens.json and server.json", () => {
    const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-r2i3a-"))
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const clusterDir = path.join(tmpRepo, ".harness", "omnigraph-cluster")
      fs.mkdirSync(clusterDir, { recursive: true })
      const authPath = path.join(clusterDir, "auth-tokens.json")
      fs.writeFileSync(authPath, "{corrupt-auth", { encoding: "utf8", mode: 0o600 })
      fs.chmodSync(authPath, 0o600)
      fs.writeFileSync(path.join(clusterDir, "server.json"), "{corrupt-server", "utf8")

      expect(
        readAuthTokensFromClusterDir(clusterDir, extendedTestHostIo, "harness-cli"),
      ).toBeUndefined()
      const fallbackUrl = resolveOmnigraphBaseUrl({ repoRoot: tmpRepo }, {}, testHostIo)
      expect(fallbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      const logs = stderrChunks.join("")
      expect(logs).toContain("failed to decode")
      expect(logs).toContain("OmnigraphAuthTokens")
      expect(logs).toContain("OmnigraphServerMeta")

      stderrChunks.length = 0
      fs.writeFileSync(
        path.join(clusterDir, "server.json"),
        JSON.stringify({
          pid: process.pid,
          port: 18081,
          baseUrl: "https://remote.example.com",
          canonicalRepoRoot: tmpRepo,
          updatedAt: null,
        }),
        "utf8",
      )
      resolveOmnigraphBaseUrl({ repoRoot: tmpRepo }, {}, testHostIo)
      expect(stderrChunks.join("")).toContain("ignoring non-loopback baseUrl")
    } finally {
      process.stderr.write = origWrite
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it.effect(
    "R2-I8c: mapOmnigraphConflictError maps unknown kind to value_constraint_violation with [rawKind] prefix while failing on invalid entityKind or typeName",
    () =>
      Effect.gen(function* () {
        const source = OmnigraphBranchName.make("impl/task")
        const target = OmnigraphBranchName.make("main")

        const unknownKindFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse(
            {
              code: "conflict",
              message: "Conflict",
              merge_conflicts: [
                {
                  kind: "unknown_kind",
                  entity_kind: "node",
                  type_name: "EffectFn",
                  entity_id: "fn.1",
                  message: "bad",
                },
              ],
            },
            409,
          )
        }
        const unknownKindErr = yield* Effect.flip(
          dryRunMergeOmnigraphBranches({ source, target, fetch: unknownKindFetch }).pipe(
            Effect.provide(OmnigraphSyncLive),
          ),
        )
        expect(unknownKindErr).toBeInstanceOf(OmnigraphMergeConflictError)
        if (!(unknownKindErr instanceof OmnigraphMergeConflictError)) {
          expect.unreachable("expected OmnigraphMergeConflictError")
        }
        expect(unknownKindErr.conflicts).toHaveLength(1)
        expect(unknownKindErr.conflicts[0]?.kind).toBe("value_constraint_violation")
        expect(unknownKindErr.conflicts[0]?.message).toBe("[unknown_kind] bad")

        for (const badConflict of [
          {
            kind: "divergent_update",
            entity_kind: "hyperedge",
            type_name: "EffectFn",
            entity_id: "fn.1",
            message: "bad",
          },
          {
            kind: "divergent_update",
            entity_kind: "node",
            type_name: "   ",
            entity_id: "fn.1",
            message: "bad",
          },
        ]) {
          const badFetch: FetchLike = (input) => {
            if (toUrlString(input).endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            return jsonResponse(
              {
                code: "conflict",
                message: "Conflict",
                merge_conflicts: [badConflict],
              },
              409,
            )
          }
          const err = yield* Effect.flip(
            dryRunMergeOmnigraphBranches({ source, target, fetch: badFetch }).pipe(
              Effect.provide(OmnigraphSyncLive),
            ),
          )
          expect(err).toBeInstanceOf(OmnigraphLoadError)
        }
      }),
  )

  it.effect(
    "F-13.1: pollOmnigraphChanges fails with OmnigraphLoadError on malformed non-empty cursor while preserving null",
    () =>
      Effect.gen(function* () {
        const whitespaceCursorFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse({
            blocks: [],
            cursor: "   ",
            caughtUp: true,
            nextPageToken: null,
          })
        }
        const err = yield* Effect.flip(
          pollOmnigraphChanges({ fetch: whitespaceCursorFetch }).pipe(
            Effect.provide(OmnigraphSyncLive),
          ),
        )
        expect(err).toBeInstanceOf(OmnigraphLoadError)

        const nullCursorFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse({
            blocks: [],
            cursor: null,
            caughtUp: true,
            nextPageToken: null,
          })
        }
        const okFeed = yield* pollOmnigraphChanges({ fetch: nullCursorFetch }).pipe(
          Effect.provide(OmnigraphSyncLive),
        )
        expect(okFeed.cursor).toBeNull()
      }),
  )

  it.effect(
    "F-13.2: mutateOmnigraphConditional fails closed with OmnigraphLoadError on malformed commitId",
    () =>
      Effect.gen(function* () {
        const badCommitFetch: FetchLike = (input) => {
          if (toUrlString(input).endsWith("/healthz")) {
            return Promise.resolve(
              new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
            )
          }
          return jsonResponse({
            branch: "main",
            commit: { graphCommitId: "   " },
            affectedNodes: 1,
            affectedEdges: 0,
            queryName: "test_mut",
          })
        }
        const err = yield* Effect.flip(
          mutateOmnigraphConditional({
            query: "MATCH (n) RETURN n",
            ifGraphCommit: OmnigraphCommitId.make("cmt-1"),
            fetch: badCommitFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive)),
        )
        expect(err).toBeInstanceOf(OmnigraphLoadError)
      }),
  )

  it("F-13.3: toOmnigraphServerNdjson throws OmnigraphLoadError on unmappable edge role", () => {
    const base = buildHarnessGraph({
      fns: [
        {
          qualname: "libs/a/src/index.ts#a",
          spanName: "A.a",
          file: "libs/a/src/index.ts",
          line: 1,
          packageTag: "domain",
        },
        {
          qualname: "libs/a/src/index.ts#b",
          spanName: "A.b",
          file: "libs/a/src/index.ts",
          line: 2,
          packageTag: "domain",
        },
      ],
    })
    const invalidGraph = {
      ...base,
      graph: Graph.mutate(base.graph, (mutable) => {
        const indices = [...Graph.nodes(mutable)].map(([idx]) => idx)
        if (indices[0] !== undefined && indices[1] !== undefined) {
          Graph.addEdge(mutable, indices[0], indices[1], {
            _tag: "PlaysRole",
            relationId: RelationId.make("bad-rel"),
            entityKey: NodeKey.make("libs/a/src/index.ts#b"),
            role: RoleName.make("unmappable-role"),
            archimateRelation: "Flow",
          })
        }
      }),
    }
    expect(() => toOmnigraphServerNdjson(invalidGraph)).toThrow(OmnigraphLoadError)
  })

  it.effect(
    "P0: syncToOmnigraphAndSnapshot does not clobber existing snapshot when graph is empty",
    () =>
      Effect.gen(function* () {
        const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-empty-"))
        try {
          const snapshotPath = path.join(tmpRepo, ".harness", "graph-snapshot.json")
          fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
          const sentinel = JSON.stringify({ sentinel: "keep-existing-snapshot" })
          fs.writeFileSync(snapshotPath, sentinel, "utf8")

          const emptyGraph = buildHarnessGraph({})
          const res = yield* syncToOmnigraphAndSnapshot(emptyGraph, {
            repoRoot: tmpRepo,
            snapshotPath,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(res.syncedToOmnigraph).toBe(false)
          expect(res.error).toContain("empty graph")
          expect(fs.readFileSync(snapshotPath, "utf8")).toBe(sentinel)
        } finally {
          fs.rmSync(tmpRepo, { recursive: true, force: true })
        }
      }),
  )

  it("P1-2: writeGraphHeadMeta & updateGraphHeadCursor use nonce temp paths and clean up .graph-head.json.lock on success, error, and stale lock recovery", () => {
    const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-p1-2-lock-"))
    try {
      const seenTmpPaths: Array<string> = []
      const lockSeenDuringWrite: Array<boolean> = []
      const lockPath = path.join(tmpRepo, ".harness", ".graph-head.json.lock")

      const spyingIo = makeExtendedTestHostIo({
        writeTextSync: (filePath, content) => {
          seenTmpPaths.push(filePath)
          lockSeenDuringWrite.push(fs.existsSync(lockPath))
          extendedTestHostIo.writeTextSync(filePath, content)
        },
      })

      const written = writeGraphHeadMeta(
        tmpRepo,
        spyingIo,
        { headSha: "sha-p1-2", gitBranch: "main" },
        {},
      )
      expect(written?.headSha).toBe("sha-p1-2")
      expect(seenTmpPaths).toHaveLength(1)
      expect(path.basename(seenTmpPaths[0] ?? "")).toMatch(
        new RegExp(`^\\.graph-head\\.json\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`),
      )
      expect(lockSeenDuringWrite).toEqual([true])
      expect(fs.existsSync(lockPath)).toBe(false)

      const updated = updateGraphHeadCursor(
        tmpRepo,
        spyingIo,
        OmnigraphChangeCursor.make("cur-p1-2"),
        {},
      )
      expect(updated?.changeFeedCursor).toBe("cur-p1-2")
      expect(seenTmpPaths).toHaveLength(2)
      expect(path.basename(seenTmpPaths[1] ?? "")).toMatch(
        new RegExp(`^\\.graph-head\\.json\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`),
      )
      expect(seenTmpPaths[0]).not.toBe(seenTmpPaths[1])
      expect(fs.existsSync(lockPath)).toBe(false)

      // Error path inside locked callback still removes lockfile
      expect(() =>
        withGraphHeadLock(
          tmpRepo,
          extendedTestHostIo,
          () => {
            expect(fs.existsSync(lockPath)).toBe(true)
            throw new Error("boom-inside-lock")
          },
          {},
        ),
      ).toThrow("boom-inside-lock")
      expect(fs.existsSync(lockPath)).toBe(false)

      // Stale lock recovery (>5000ms old) unlinks stale lock, acquires fresh lock, and cleans up
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() - 10_000 }), "utf8")
      const recovered = writeGraphHeadMeta(
        tmpRepo,
        spyingIo,
        { headSha: "sha-stale-recovered", gitBranch: "main" },
        {},
      )
      expect(recovered?.headSha).toBe("sha-stale-recovered")
      expect(lockSeenDuringWrite[2]).toBe(true)
      expect(fs.existsSync(lockPath)).toBe(false)

      // Non-stale lock is preserved on cleanup (not unlinked by contender)
      const freshLockContent = JSON.stringify({ pid: 999998, ts: Date.now() })
      fs.writeFileSync(lockPath, freshLockContent, "utf8")
      withGraphHeadLock(tmpRepo, extendedTestHostIo, () => undefined, {})
      expect(fs.existsSync(lockPath)).toBe(true)
      expect(fs.readFileSync(lockPath, "utf8")).toBe(freshLockContent)
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it("P1-4: readAuthTokensFromClusterDir rejects permissive (0o644) and undefined modes while accepting 0o600", () => {
    const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-p1-4-auth-mode-"))
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
    try {
      const clusterDir = path.join(tmpRepo, ".harness", "omnigraph-cluster")
      fs.mkdirSync(clusterDir, { recursive: true })
      const authPath = path.join(clusterDir, "auth-tokens.json")
      fs.writeFileSync(
        authPath,
        JSON.stringify({ schemaVersion: 1, cliToken: "cli-tok", mcpToken: "mcp-tok" }),
        { encoding: "utf8", mode: 0o600 },
      )
      fs.chmodSync(authPath, 0o600)

      // 0o600 succeeds
      expect(readAuthTokensFromClusterDir(clusterDir, extendedTestHostIo, "harness-cli")).toBe(
        "cli-tok",
      )

      // 0o644 permissive mode is rejected
      const permissiveIo = makeExtendedTestHostIo({
        statModeSync: () => 0o100644,
      })
      expect(readAuthTokensFromClusterDir(clusterDir, permissiveIo, "harness-cli")).toBeUndefined()
      expect(stderrChunks.join("")).toContain("permissive (644) mode")

      // undefined mode (or SyncHostIo without statModeSync) is rejected
      stderrChunks.length = 0
      const unknownModeIo = makeExtendedTestHostIo({
        statModeSync: () => undefined,
      })
      expect(readAuthTokensFromClusterDir(clusterDir, unknownModeIo, "harness-cli")).toBeUndefined()
      expect(readAuthTokensFromClusterDir(clusterDir, testHostIo, "harness-cli")).toBeUndefined()
      expect(stderrChunks.join("")).toContain("unknown mode")
    } finally {
      process.stderr.write = origWrite
      fs.rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it.effect(
    "P1-5: mergeBranch persists graph-head.json before cleanupBranches delete failures",
    () =>
      Effect.gen(function* () {
        const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-p1-5-merge-order-"))
        try {
          fs.mkdirSync(path.join(tmpRepo, ".git", "refs", "heads"), { recursive: true })
          fs.writeFileSync(path.join(tmpRepo, ".git", "HEAD"), "ref: refs/heads/main\n")
          fs.writeFileSync(
            path.join(tmpRepo, ".git", "refs", "heads", "main"),
            "merge-head-sha-1\n",
          )

          let headMetaWrittenBeforeCleanupDelete = false
          const mockFetch: FetchLike = (input, init) => {
            const url = toUrlString(input)
            const method = init?.method ?? "GET"
            if (url.endsWith("/graphs/harness/branches") && method === "GET") {
              return jsonResponse({ branches: ["main", "impl/task", "plan/task"] })
            }
            if (url.endsWith("/graphs/harness/branches/merge")) {
              return jsonResponse({
                outcome: "fast_forward",
                source: "impl/task",
                target: "main",
                branch_deleted: true,
                commit: {
                  graph_commit_id: "cmt-merge-p1-5",
                  created_at: 1002,
                  graph_manifest_version: 1,
                  graph_branch: "main",
                  parent_commit_id: "cmt-parent-0",
                  merged_parent_commit_id: "cmt-impl-0",
                  kind: "published",
                  published: true,
                },
              })
            }
            if (method === "DELETE" && url.includes("/graphs/harness/branches/")) {
              const metaDuringCleanup = readGraphHeadMeta(tmpRepo, extendedTestHostIo, {})
              headMetaWrittenBeforeCleanupDelete =
                metaDuringCleanup?.omnigraphCommitId === "cmt-merge-p1-5"
              return Promise.resolve(
                new Response("cleanup delete failed", {
                  status: 500,
                  headers: { "Omnigraph-Http-Api": "0.14" },
                }),
              )
            }
            return jsonResponse({})
          }

          yield* mergeOmnigraphBranch({
            repoRoot: tmpRepo,
            source: "impl/task",
            target: "main",
            cleanupBranches: ["impl/task", "plan/task"],
            fetch: mockFetch,
          }).pipe(Effect.provide(makeOmnigraphSyncLayer(extendedTestHostIo, {})))

          expect(headMetaWrittenBeforeCleanupDelete).toBe(true)
          const finalMeta = readGraphHeadMeta(tmpRepo, extendedTestHostIo, {})
          expect(finalMeta?.omnigraphCommitId).toBe("cmt-merge-p1-5")
        } finally {
          fs.rmSync(tmpRepo, { recursive: true, force: true })
        }
      }),
  )

  it.effect(
    "P1-6: sync does not overwrite existing graph-snapshot.json when og.load fails, but creates missing fallback snapshot",
    () =>
      Effect.gen(function* () {
        const tmpRepo = fs.mkdtempSync(path.join(tmpdir(), "og-v014-p1-6-snapshot-order-"))
        try {
          const snapshotPath = path.join(tmpRepo, ".harness", "graph-snapshot.json")
          const fail500Fetch: FetchLike = (input) => {
            if (toUrlString(input).endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            return Promise.resolve(
              new Response("load failed", {
                status: 500,
                headers: { "Omnigraph-Http-Api": "0.14" },
              }),
            )
          }

          // 1. Missing snapshot: fallback creates snapshotPath on failure
          const initialRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: tmpRepo,
            snapshotPath,
            fetch: fail500Fetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(initialRes.syncedToOmnigraph).toBe(false)
          expect(fs.existsSync(snapshotPath)).toBe(true)

          // 2. Existing snapshot: failure does NOT overwrite existing snapshotPath
          const sentinel = JSON.stringify({ sentinel: "keep-on-load-failure" })
          fs.writeFileSync(snapshotPath, sentinel, "utf8")
          const failAgainRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: tmpRepo,
            snapshotPath,
            fetch: fail500Fetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(failAgainRes.syncedToOmnigraph).toBe(false)
          expect(fs.readFileSync(snapshotPath, "utf8")).toBe(sentinel)

          // 3. Successful load updates snapshotPath
          const okFetch: FetchLike = (input) => {
            if (toUrlString(input).endsWith("/healthz")) {
              return Promise.resolve(
                new Response(null, { status: 200, headers: { "Omnigraph-Http-Api": "0.14" } }),
              )
            }
            return jsonResponse({
              branch: "main",
              branch_created: false,
              commit: {
                graph_commit_id: "cmt-ok-p1-6",
                created_at: 1003,
                graph_manifest_version: 1,
                kind: "published",
              },
              edges: [],
              embedding_generation: null,
              mode: "merge",
            })
          }
          const okRes = yield* syncToOmnigraphAndSnapshot(sampleGraph, {
            repoRoot: tmpRepo,
            snapshotPath,
            fetch: okFetch,
          }).pipe(Effect.provide(OmnigraphSyncLive))
          expect(okRes.syncedToOmnigraph).toBe(true)
          expect(fs.readFileSync(snapshotPath, "utf8")).not.toBe(sentinel)
          expect(fs.readFileSync(snapshotPath, "utf8")).toContain("Sample.ping")
        } finally {
          fs.rmSync(tmpRepo, { recursive: true, force: true })
        }
      }),
  )
})
