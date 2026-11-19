import {
  chmodSync,
  existsSync,
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
import { Effect, Redacted } from "effect"
import { match } from "ts-pattern"
import {
  type ErrorReasonMessage,
  type MutationCacheHmacSecret,
  type MutationCacheHmacSecretResult,
  WorkspaceFilePath,
} from "@harness/contract"
import { nodeSyncHostIo, resolveOrCreateMutationCacheHmacSecret } from "../src/index.js"

const withTempRoot = <A>(use: (root: string) => A): A => {
  const dir = mkdtempSync(join(tmpdir(), "harness-hmac-secret-test-"))
  try {
    return use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const expectResolvedSecret = (result: MutationCacheHmacSecretResult): MutationCacheHmacSecret =>
  match(result)
    .with({ _tag: "Resolved" }, ({ secret }) => Redacted.value(secret))
    .with({ _tag: "Unavailable" }, ({ reason }) => {
      expect.unreachable(`Expected Resolved secret, got Unavailable: ${reason}`)
    })
    .exhaustive()

const expectUnavailableReason = (result: MutationCacheHmacSecretResult): ErrorReasonMessage =>
  match(result)
    .with({ _tag: "Unavailable" }, ({ reason }) => reason)
    .with({ _tag: "Resolved" }, () => {
      expect.unreachable("Expected Unavailable result, got Resolved")
    })
    .exhaustive()

describe("resolveOrCreateMutationCacheHmacSecret", () => {
  it.effect("creates a 0o600 secret in a 0o700 out-of-workspace directory and reuses it", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        const keyDir = WorkspaceFilePath.make(join(root, "cache-home", "effect-harness"))
        mkdirSync(repoRoot, { recursive: true })

        const first = expectResolvedSecret(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: keyDir }),
        )
        const keyFile = join(keyDir, "mutation-hmac-v2.key")
        expect(statSync(keyDir).mode & 0o077).toBe(0)
        expect(statSync(keyFile).mode & 0o077).toBe(0)
        expect(readFileSync(keyFile, "utf8").trim()).toBe(first)

        const second = expectResolvedSecret(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: keyDir }),
        )
        expect(second).toBe(first)
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
        const winningSecret = "01234567".repeat(8)

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

        const resolved = expectResolvedSecret(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, {
            hostIo: raceIo,
            keyDirOverride: keyDir,
          }),
        )
        expect(resolved).toBe(winningSecret)
      }),
    ),
  )

  it.effect("F-17.b: repairs permissive 0o644 existing key file to 0o600", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        const keyDir = WorkspaceFilePath.make(join(root, "repair-cache"))
        mkdirSync(repoRoot, { recursive: true })
        mkdirSync(keyDir, { recursive: true, mode: 0o700 })
        const keyFile = join(keyDir, "mutation-hmac-v2.key")
        const existingSecret = "01234567".repeat(8)
        writeFileSync(keyFile, `${existingSecret}\n`, { encoding: "utf8", mode: 0o644 })
        chmodSync(keyFile, 0o644)

        const resolved = expectResolvedSecret(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: keyDir }),
        )
        expect(resolved).toBe(existingSecret)
        expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      }),
    ),
  )

  it.effect("F-17.b: resolves default key directory under XDG_CACHE_HOME", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        const xdgDir = join(root, "xdg-cache")
        mkdirSync(repoRoot, { recursive: true })

        const resolved = expectResolvedSecret(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, {
            env: { XDG_CACHE_HOME: xdgDir },
          }),
        )
        const expectedKeyFile = join(xdgDir, "effect-harness", "mutation-hmac-v2.key")
        expect(existsSync(expectedKeyFile)).toBe(true)
        expect(statSync(expectedKeyFile).mode & 0o777).toBe(0o600)
        expect(readFileSync(expectedKeyFile, "utf8").trim()).toBe(resolved)
      }),
    ),
  )

  it.effect("S-3.a: fails closed when key directory lies inside repoRoot", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        mkdirSync(repoRoot, { recursive: true })
        const inRepoKeyDir = WorkspaceFilePath.make(join(repoRoot, ".harness", "cache"))

        const reason = expectUnavailableReason(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: inRepoKeyDir }),
        )
        expect(reason).toContain("lies inside workspace")
        expect(existsSync(join(repoRoot, ".harness"))).toBe(false)
        expect(existsSync(join(inRepoKeyDir, "mutation-hmac-v2.key"))).toBe(false)
      }),
    ),
  )

  it.effect("S-3.a: fails closed when key directory is a symlink", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        mkdirSync(repoRoot, { recursive: true })
        const realTargetDir = join(root, "real-cache-target")
        mkdirSync(realTargetDir, { recursive: true, mode: 0o700 })
        const symKeyDir = WorkspaceFilePath.make(join(root, "symlinked-cache"))
        symlinkSync(realTargetDir, symKeyDir)

        const reason = expectUnavailableReason(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: symKeyDir }),
        )
        expect(reason).toContain("Refusing symlink HMAC key directory")
      }),
    ),
  )

  it.effect("S-3.a: fails closed when key file is a symlink", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        mkdirSync(repoRoot, { recursive: true })
        const symKeyDir = WorkspaceFilePath.make(join(root, "sym-cache"))
        mkdirSync(symKeyDir, { recursive: true, mode: 0o700 })
        const decoyFile = join(root, "decoy.key")
        writeFileSync(decoyFile, "f".repeat(64), { mode: 0o600 })
        symlinkSync(decoyFile, join(symKeyDir, "mutation-hmac-v2.key"))

        const reason = expectUnavailableReason(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: symKeyDir }),
        )
        expect(reason).toContain("Refusing symlink HMAC key file")
      }),
    ),
  )

  it.effect("S-3.a: fails closed on corrupt short key without rotating", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        mkdirSync(repoRoot, { recursive: true })
        const badContentDir = WorkspaceFilePath.make(join(root, "bad-content"))
        mkdirSync(badContentDir, { recursive: true, mode: 0o700 })
        const keyFile = join(badContentDir, "mutation-hmac-v2.key")
        writeFileSync(keyFile, "short", { mode: 0o600 })

        const reason = expectUnavailableReason(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, { keyDirOverride: badContentDir }),
        )
        expect(reason).toContain("Corrupt or invalid HMAC secret")
        expect(readFileSync(keyFile, "utf8")).toBe("short")
      }),
    ),
  )

  it.effect("S-3.a: fails closed when world-readable key cannot be chmod repaired", () =>
    Effect.sync(() =>
      withTempRoot((root) => {
        const repoRoot = WorkspaceFilePath.make(join(root, "repo"))
        mkdirSync(repoRoot, { recursive: true })
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

        const reason = expectUnavailableReason(
          resolveOrCreateMutationCacheHmacSecret(repoRoot, {
            hostIo: stuckPermIo,
            keyDirOverride: openPermsDir,
          }),
        )
        expect(reason).toContain("Failed to enforce private permissions")
      }),
    ),
  )
})
