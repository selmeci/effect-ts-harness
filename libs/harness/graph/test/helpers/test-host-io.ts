import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExclusiveWriteResult, ExtendedHostIo } from "@harness/service/host-io"
import { makeTestHostIo, testHostIo } from "@harness/service/testing"
import { Result } from "effect"
import { match } from "ts-pattern"

export { makeTestHostIo, testHostIo }

const getErrnoCode = (err: unknown): string | undefined => {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code
  }
  return undefined
}

export const makeExtendedTestHostIo = (
  overrides?: Partial<ExtendedHostIo>,
): ExtendedHostIo => ({
  ...testHostIo,
  rmRecursiveSync: (targetPath) => {
    fs.rmSync(targetPath, { recursive: true, force: true })
  },
  cpRecursiveSync: (srcPath, destPath) => {
    fs.cpSync(srcPath, destPath, { recursive: true })
  },
  mkdtempSync: (prefix) => fs.mkdtempSync(join(tmpdir(), prefix)),
  statMtimeMsSync: (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })?.mtimeMs,
  statModeSync: (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })?.mode,
  chmodSync: (filePath, mode) => {
    fs.chmodSync(filePath, mode)
  },
  writeTextWithModeSync: (filePath, content, mode) => {
    fs.writeFileSync(filePath, content, { encoding: "utf8", mode })
    fs.chmodSync(filePath, mode)
  },
  tryWriteExclusiveTextSync: (
    filePath,
    content,
    mode = 0o600,
  ): ExclusiveWriteResult => {
    const res = Result.try({
      try: () => {
        fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "wx", mode })
      },
      catch: (err) => ({
        code: getErrnoCode(err),
        message: err instanceof Error ? err.message : String(err),
      }),
    })
    return match(res)
      .with({ _tag: "Success" }, () => ({ _tag: "Written" as const }))
      .with({ _tag: "Failure" }, ({ failure }) =>
        failure.code === "EEXIST"
          ? { _tag: "Exists" as const }
          : {
              _tag: "Failed" as const,
              code: failure.code,
              message: failure.message,
            },
      )
      .exhaustive()
  },
  spawnDetached: () => ({
    _tag: "SpawnFailed",
    spawnError: "spawnDetached not supported in testHostIo",
  }),
  ...overrides,
})

export const extendedTestHostIo: ExtendedHostIo = makeExtendedTestHostIo()
