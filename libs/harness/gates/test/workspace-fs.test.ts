import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { match } from "ts-pattern"
import { WorkspaceFilePath, WorkspaceFsError } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import { statAndReadWorkspaceFiles } from "../src/services/workspace-fs.js"
import {
  isWorkspaceTsSourceFileName,
  scanWorkspaceTsFilesChecked,
} from "../src/workspace-ts-scan.js"
import { testHostIo } from "./helpers/test-host-io.js"
import { makeWorkspaceFsMemoryLayer } from "./helpers/test-layers.js"

describe("WorkspaceFs.statAndReadAll", () => {
  it.effect("reads multiple workspace files in order and computes line counts", () =>
    Effect.gen(function* () {
      const files = {
        "libs/alpha.ts": "const a = 1\nconst b = 2\n",
        "libs/beta.ts": "single-line",
        "libs/gamma.ts": "one\ntwo\nthree",
      }
      const stats = yield* statAndReadWorkspaceFiles([
        WorkspaceFilePath.make("libs/gamma.ts"),
        WorkspaceFilePath.make("libs/alpha.ts"),
        WorkspaceFilePath.make("libs/beta.ts"),
      ]).pipe(Effect.provide(makeWorkspaceFsMemoryLayer(files)))

      expect(stats.map((s) => s.filePath)).toEqual([
        "libs/gamma.ts",
        "libs/alpha.ts",
        "libs/beta.ts",
      ])
      expect(stats[0]?.lineCount).toBe(3)
      expect(stats[1]?.lineCount).toBe(3)
      expect(stats[2]?.lineCount).toBe(1)
    }),
  )

  it.effect("propagates WorkspaceFsError when any requested file is missing", () =>
    Effect.gen(function* () {
      const exit = yield* statAndReadWorkspaceFiles([
        WorkspaceFilePath.make("libs/alpha.ts"),
        WorkspaceFilePath.make("libs/missing.ts"),
      ]).pipe(
        Effect.provide(makeWorkspaceFsMemoryLayer({ "libs/alpha.ts": "export const ok = true\n" })),
        Effect.exit,
      )

      const failureCause = match(exit)
        .with({ _tag: "Failure" }, (f) => f.cause)
        .with({ _tag: "Success" }, () => {
          throw new Error("Expected statAndReadWorkspaceFiles to fail on missing file")
        })
        .exhaustive()

      const errOpt = Cause.findErrorOption(failureCause)
      const fsError = match(errOpt)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => {
          throw new Error("Expected typed WorkspaceFsError in failure cause")
        })
        .exhaustive()

      expect(fsError).toBeInstanceOf(WorkspaceFsError)
      expect(fsError.filePath).toBe("libs/missing.ts")
      expect(fsError.operation).toBe("read")
    }),
  )
})

describe("scanWorkspaceTsFilesChecked", () => {
  it("scans .ts and .tsx while excluding .d.ts/excluded dirs and fails closed on symlinks and readdir errors", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-ts-test-"))
    try {
      const scanRoot = join(tmp, "root")
      const subDir = join(scanRoot, "sub")
      const nmDir = join(scanRoot, "node_modules")
      mkdirSync(subDir, { recursive: true })
      mkdirSync(nmDir, { recursive: true })
      writeFileSync(join(scanRoot, "a.ts"), "export const a = 1\n", "utf8")
      writeFileSync(join(subDir, "b.tsx"), "export const b = 2\n", "utf8")
      writeFileSync(join(subDir, "types.d.ts"), "export type T = string\n", "utf8")
      writeFileSync(join(nmDir, "ignored.ts"), "export const ignored = 1\n", "utf8")

      expect(isWorkspaceTsSourceFileName("a.ts")).toBe(true)
      expect(isWorkspaceTsSourceFileName("b.tsx")).toBe(true)
      expect(isWorkspaceTsSourceFileName("types.d.ts")).toBe(false)

      const okRes = scanWorkspaceTsFilesChecked(scanRoot, testHostIo)
      match(okRes)
        .with({ _tag: "Ok" }, ({ files }) => {
          expect(files).toEqual([join(scanRoot, "a.ts"), join(subDir, "b.tsx")])
        })
        .with({ _tag: "Error" }, ({ reason }) => {
          expect.unreachable(`Expected Ok scan result, got: ${reason}`)
        })
        .exhaustive()

      const missingRes = scanWorkspaceTsFilesChecked(join(tmp, "does-not-exist"), testHostIo)
      expect(missingRes).toEqual({ _tag: "Ok", files: [] })

      const rootReaddirFailIo: SyncHostIo = {
        ...testHostIo,
        readdirSync: () => {
          throw new Error("EACCES: root")
        },
      }
      const rootFailRes = scanWorkspaceTsFilesChecked(scanRoot, rootReaddirFailIo)
      expect(rootFailRes._tag).toBe("Error")

      const subReaddirFailIo: SyncHostIo = {
        ...testHostIo,
        readdirSync: (dirPath) => {
          if (dirPath === subDir) throw new Error("EACCES: subdir")
          return testHostIo.readdirSync(dirPath)
        },
      }
      const subFailRes = scanWorkspaceTsFilesChecked(scanRoot, subReaddirFailIo)
      expect(subFailRes._tag).toBe("Error")

      const symlinkRoot = join(tmp, "sym-root")
      symlinkSync(scanRoot, symlinkRoot)
      const symRootRes = scanWorkspaceTsFilesChecked(symlinkRoot, testHostIo)
      expect(symRootRes._tag).toBe("Error")

      const evilFile = join(tmp, "outside.ts")
      writeFileSync(evilFile, "export const evil = 1\n", "utf8")
      symlinkSync(evilFile, join(subDir, "evil.ts"))
      const symEntryRes = scanWorkspaceTsFilesChecked(scanRoot, testHostIo)
      expect(symEntryRes._tag).toBe("Error")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
