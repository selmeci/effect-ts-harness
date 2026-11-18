import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { WorkspaceFilePath } from "@harness/contract"
import { nodeSyncHostIo, resolveOrCreateMutationCacheHmacSecret } from "../src/index.js"

const withTempRoot = <A>(use: (root: string) => A): A => {
  const dir = mkdtempSync(join(tmpdir(), "harness-hmac-secret-test-"))
  try {
    return use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("resolveOrCreateMutationCacheHmacSecret", () => {
  it.effect(
    "creates a 0o600 secret in a 0o700 out-of-workspace directory and reuses it stably",
    () =>
      Effect.sync(() =>
        withTempRoot((root) => {
          const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
          const keyDir = WorkspaceFilePath.make(join(root, "cache-home", "effect-harness"))
          mkdirSync(repoRoot, { recursive: true })

          const first = resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: keyDir })
          expect(Option.isSome(first)).toBe(true)
          const keyFile = join(keyDir, "mutation-hmac-v2.key")
          expect(statSync(keyDir).mode & 0o077).toBe(0)
          expect(statSync(keyFile).mode & 0o077).toBe(0)
          expect(readFileSync(keyFile, "utf8").trim()).toBe(Option.getOrUndefined(first))

          const second = resolveOrCreateMutationCacheHmacSecret(repoRoot, {
            keyDirOverride: keyDir,
          })
          expect(Option.getOrUndefined(second)).toBe(Option.getOrUndefined(first))
        }),
      ),
  )

  it.effect("handles concurrent EEXIST creation by reading the winning process key", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        const keyDir = WorkspaceFilePath.make(join(root, "cache-home"))
        mkdirSync(repoRoot, { recursive: true })
        mkdirSync(keyDir, { recursive: true, mode: 0o700 })
        const keyFile = join(keyDir, "mutation-hmac-v2.key")
        const winningSecret = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"

        let firstExistsCheck = true
        const raceIo = {
          ...nodeSyncHostIo,
          existsSync: (targetPath: string) => {
            if (targetPath === keyFile && firstExistsCheck) {
              firstExistsCheck = false
              writeFileSync(keyFile, `${winningSecret}\n`, { encoding: "utf8", mode: 0o600 })
              return false
            }
            return nodeSyncHostIo.existsSync(targetPath)
          },
        }

        const resolved = resolveOrCreateMutationCacheHmacSecret(repoRoot, {
          hostIo: raceIo,
          keyDirOverride: keyDir,
        })
        expect(Option.getOrUndefined(resolved)).toBe(winningSecret)
      }),
    ),
  )

  it.effect(
    "fails closed if the key directory lies inside repoRoot, is a symlink, or holds invalid/unfixable permissions",
    () =>
      Effect.sync(() =>
        withTempRoot((root) => {
          const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
          mkdirSync(repoRoot, { recursive: true })

          // In-repo key directory must fail closed
          const inRepoKeyDir = WorkspaceFilePath.make(join(repoRoot, ".harness", "cache"))
          expect(
            Option.isNone(
              resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: inRepoKeyDir }),
            ),
          ).toBe(true)

          // Symlinked key file must fail closed
          const symKeyDir = WorkspaceFilePath.make(join(root, "sym-cache"))
          mkdirSync(symKeyDir, { recursive: true, mode: 0o700 })
          const decoyFile = join(root, "decoy.key")
          writeFileSync(decoyFile, "f".repeat(64), { mode: 0o600 })
          symlinkSync(decoyFile, join(symKeyDir, "mutation-hmac-v2.key"))
          expect(
            Option.isNone(
              resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: symKeyDir }),
            ),
          ).toBe(true)

          // Corrupted short secret must fail closed rather than rotating silently
          const badContentDir = WorkspaceFilePath.make(join(root, "bad-content"))
          mkdirSync(badContentDir, { recursive: true, mode: 0o700 })
          writeFileSync(join(badContentDir, "mutation-hmac-v2.key"), "short", { mode: 0o600 })
          expect(
            Option.isNone(
              resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: badContentDir }),
            ),
          ).toBe(true)

          // World-readable key that cannot be chmod'd back must fail closed
          const openPermsDir = WorkspaceFilePath.make(join(root, "open-perms"))
          mkdirSync(openPermsDir, { recursive: true, mode: 0o700 })
          const openKeyFile = join(openPermsDir, "mutation-hmac-v2.key")
          writeFileSync(openKeyFile, "e".repeat(64), { mode: 0o644 })
          chmodSync(openKeyFile, 0o644)
          const stuckPermIo = {
            ...nodeSyncHostIo,
            chmodSync: () => {
              throw new Error("EPERM")
            },
          }
          expect(
            Option.isNone(
              resolveOrCreateMutationCacheHmacSecret(repoRoot, {
                hostIo: stuckPermIo,
                keyDirOverride: openPermsDir,
              }),
            ),
          ).toBe(true)
        }),
      ),
  )
})
