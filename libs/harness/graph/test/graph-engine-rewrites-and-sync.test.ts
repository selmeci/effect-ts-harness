import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as GraphApi from "../src/index.js"
import { makeOmnigraphSyncLayer, OmnigraphSync, structuralSearch } from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"
import { makeSampleGraph } from "./helpers/graph-engine-fixture.js"

describe("HarnessGraph structural search, OmnigraphSync & export surface", () => {
  it("finds TypeScript ast-grep matches via structuralSearch", () => {
    const results = structuralSearch({
      pattern: "export const $NAME = $_",
      hostIo: testHostIo,
      subDirs: ["libs/harness/graph/src"],
    })
    expect(results.length).toBeGreaterThan(0)
    const match = results.find((r) => r.text.includes("buildHarnessGraph"))
    expect(match).toBeDefined()
    expect(match?.file).toContain("engine/hypergraph-store.ts")
    expect(match?.line).toBeGreaterThan(0)
  })

  it("writes snapshot and handles offline server gracefully via OmnigraphSync", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-engine-sync-"))
    const testSnapshotPath = path.join(tmpDir, ".harness", "sync-test-snapshot.json")
    try {
      const program = Effect.gen(function* () {
        const syncService = yield* OmnigraphSync
        return yield* syncService.sync(makeSampleGraph(), {
          snapshotPath: testSnapshotPath,
          baseUrl: "http://127.0.0.1:9999", // Unreachable port
        })
      }).pipe(Effect.provide(makeOmnigraphSyncLayer(testHostIo)))

      const result = await Effect.runPromise(program)
      expect(result.snapshotPath).toBe(testSnapshotPath)
      expect(result.syncedToOmnigraph).toBe(false)
      expect(fs.existsSync(testSnapshotPath)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe("F-4: Public export surface guard", () => {
    it("ensures internal helper symbols are not leaked on public GraphApi while core exports are defined", () => {
      // Internal helpers must not be exposed on the public package index
      expect(GraphApi).not.toHaveProperty("pushUnique")
      expect(GraphApi).not.toHaveProperty("sha256Hex")
      expect(GraphApi).not.toHaveProperty("makeProofRegistrar")
      expect(GraphApi).not.toHaveProperty("addEntityNodeIfMissing")
      expect(GraphApi).not.toHaveProperty("addViolation")
      expect(GraphApi).not.toHaveProperty("decodePackageJson")

      // Core public APIs must be exported
      expect(GraphApi.buildHarnessGraph).toBeDefined()
      expect(GraphApi.resolveNode).toBeDefined()
      expect(GraphApi.findCallers).toBeDefined()
      expect(GraphApi.extractWorkspaceTypeAwareGraph).toBeDefined()
      expect(GraphApi.decideGraphInference).toBeDefined()
      expect(GraphApi.decideGraphRewrite).toBeDefined()
      expect(GraphApi.decideGraphProjection).toBeDefined()
      expect(GraphApi.loadGraphSnapshotEffect).toBeDefined()
      expect(GraphApi.DatalogSession).toBeDefined()
    })
  })
})
