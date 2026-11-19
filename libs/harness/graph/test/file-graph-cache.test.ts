import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { SyncHostIo, SyncHostReader } from "@harness/service/host-io"
import { describe, expect, it } from "@effect/vitest"
import {
  type FileGraphCacheSession,
  type FileGraphFragment,
  saveFileGraphFragmentsToDisk,
} from "../src/extractor/file-graph-cache.js"
import { testHostIo } from "./helpers/test-host-io.js"

const makeSampleFragment = (): FileGraphFragment => ({
  filePath: "libs/sample/domain/src/index.ts",
  packageTag: "domain",
  contentSha256: "abc123",
  declHash: "def456",
  importedSpecs: [],
  fns: [],
  layers: [],
  requiresService: [],
  failsWith: [],
  providesService: [],
  layerRequires: [],
  branchingViolations: [],
})

const makeSession = (hostIo: SyncHostReader): FileGraphCacheSession => {
  const frag = makeSampleFragment()
  return {
    hostIo,
    persistToDisk: true,
    fileFragmentCache: new Map([[frag.filePath, frag]]),
    sourceFileCache: new Map(),
  }
}

describe("S-6a: isSyncHostIo and saveFileGraphFragmentsToDisk", () => {
  it("skips persistence when session.hostIo is a read-only SyncHostReader or missing execFileSync", () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "file-graph-cache-ro-"))
    try {
      const readOnlyHostIo: SyncHostReader = {
        getEnv: () => process.env,
        existsSync: testHostIo.existsSync,
        isFileSync: testHostIo.isFileSync,
        isDirectorySync: testHostIo.isDirectorySync,
        isSymbolicLinkSync: testHostIo.isSymbolicLinkSync,
        readTextSync: testHostIo.readTextSync,
        readBytesSync: testHostIo.readBytesSync,
        readdirSync: testHostIo.readdirSync,
        realpathSync: testHostIo.realpathSync,
      }
      saveFileGraphFragmentsToDisk(tmpDir, makeSession(readOnlyHostIo))
      const cacheFile = path.join(tmpDir, ".harness", "cache", "file-graph-v1.json")
      expect(fs.existsSync(cacheFile)).toBe(false)

      const partialWriterWithoutExec: SyncHostReader & Record<string, unknown> = {
        ...readOnlyHostIo,
        writeTextSync: testHostIo.writeTextSync,
        appendTextSync: testHostIo.appendTextSync,
        mkdirRecursiveSync: testHostIo.mkdirRecursiveSync,
        renameSync: testHostIo.renameSync,
        unlinkSync: testHostIo.unlinkSync,
      }
      saveFileGraphFragmentsToDisk(tmpDir, makeSession(partialWriterWithoutExec))
      expect(fs.existsSync(cacheFile)).toBe(false)

      const partialWriterWithoutAppend: SyncHostReader & Record<string, unknown> = {
        ...readOnlyHostIo,
        writeTextSync: testHostIo.writeTextSync,
        mkdirRecursiveSync: testHostIo.mkdirRecursiveSync,
        renameSync: testHostIo.renameSync,
        unlinkSync: testHostIo.unlinkSync,
        execFileSync: testHostIo.execFileSync,
      }
      saveFileGraphFragmentsToDisk(tmpDir, makeSession(partialWriterWithoutAppend))
      expect(fs.existsSync(cacheFile)).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("persists file graph fragments when session.hostIo is a complete SyncHostIo", () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "file-graph-cache-rw-"))
    try {
      const fullHostIo: SyncHostIo = testHostIo
      saveFileGraphFragmentsToDisk(tmpDir, makeSession(fullHostIo))
      const cacheFile = path.join(tmpDir, ".harness", "cache", "file-graph-v1.json")
      expect(fs.existsSync(cacheFile)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
        version: string
        fragments: Record<string, FileGraphFragment>
      }
      expect(parsed.version).toBe("file-graph-v1")
      expect(parsed.fragments["libs/sample/domain/src/index.ts"]?.contentSha256).toBe("abc123")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
