import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, FileSystem, Path } from "effect"
import { match } from "ts-pattern"
import {
  AstGatePackageTag,
  AstSourceFilePath,
  CompilerVersionTag,
  computeContentSha256,
  EvaluatorId,
  GateRuleVersion,
  makePersistedAstCacheKey,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  checkNonSymlinkCachePath,
  decodeStoreForActiveVersion,
  encodePersistedStoreJson,
  readActiveEntriesForMerge,
  resolveDiskGateRuleVersion,
  resolveDiskGateRuleVersionWithPlatform,
} from "../src/ast-gate-cache-helpers.js"
import { toReadError } from "../src/cache-helpers.js"

const withTempDir = <A, E, R>(
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "harness-ast-cache-helpers-"))),
    use,
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true })
      }),
  )

describe("AstGateCache helper EffectFns", () => {
  it.effect(
    "resolveDiskGateRuleVersion & resolveDiskGateRuleVersionWithPlatform resolve explicit and hashed sources",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const explicitVer = GateRuleVersion.make("v1-explicit")
          const explicitRes = yield* resolveDiskGateRuleVersion({
            _tag: "ExplicitVersion",
            ruleVersion: explicitVer,
          })
          expect(explicitRes).toEqual({ _tag: "Resolved", ruleVersion: explicitVer })

          const ruleRel = WorkspaceFilePath.make("rules/r1.ts")
          mkdirSync(join(dir, "rules"), { recursive: true })
          writeFileSync(join(dir, ruleRel), "export const r = 1\n", "utf8")

          const hashedRes = yield* resolveDiskGateRuleVersion({
            _tag: "HashedSources",
            ruleSourceRoot: WorkspaceFilePath.make(dir),
            ruleSourceFiles: [ruleRel],
            compilerVersion: CompilerVersionTag.make("tsc-5.8"),
          })
          expect(hashedRes._tag).toBe("Resolved")

          const missingRes = yield* Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            return yield* resolveDiskGateRuleVersionWithPlatform(fs, path, {
              _tag: "HashedSources",
              ruleSourceRoot: WorkspaceFilePath.make(dir),
              ruleSourceFiles: [WorkspaceFilePath.make("rules/missing.ts")],
              compilerVersion: CompilerVersionTag.make("tsc-5.8"),
            })
          }).pipe(Effect.provide(NodeServices.layer))
          expect(missingRes._tag).toBe("Uncached")
        }),
      ),
  )

  it.effect(
    "checkNonSymlinkCachePath, decodeStoreForActiveVersion, and readActiveEntriesForMerge handle valid, version-mismatched, corrupt, and symlink paths",
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const missingPath = WorkspaceFilePath.make(join(dir, "missing.json"))
          expect(yield* checkNonSymlinkCachePath(fs, missingPath, toReadError)).toBe(false)

          const cachePath = WorkspaceFilePath.make(join(dir, "ast-cache.json"))
          const activeVer = GateRuleVersion.make("v2-active")
          const staleVer = GateRuleVersion.make("v1-stale")
          const keyActive = makePersistedAstCacheKey(
            AstSourceFilePath.make("libs/demo/domain/src/a.ts"),
            AstGatePackageTag.make("domain"),
            activeVer,
            EvaluatorId.make("default"),
          )
          const sha = computeContentSha256("export const a = 1\n")
          const rawStore = encodePersistedStoreJson({
            version: activeVer,
            entries: {
              [keyActive]: {
                contentSha256: sha,
                ruleVersion: activeVer,
                violations: [],
              },
            },
          })
          writeFileSync(cachePath, rawStore, "utf8")

          expect(yield* checkNonSymlinkCachePath(fs, cachePath, toReadError)).toBe(true)

          const decodedActive = yield* decodeStoreForActiveVersion(rawStore, activeVer, cachePath)
          expect(decodedActive.size).toBe(1)
          expect(decodedActive.get(keyActive)?.contentSha256).toBe(sha)

          const decodedStale = yield* decodeStoreForActiveVersion(rawStore, staleVer, cachePath)
          expect(decodedStale.size).toBe(0)

          const decodedCorrupt = yield* decodeStoreForActiveVersion(
            "{not-valid-json",
            activeVer,
            cachePath,
          )
          expect(decodedCorrupt.size).toBe(0)

          const mergedActive = yield* readActiveEntriesForMerge(fs, cachePath, activeVer)
          expect(mergedActive.size).toBe(1)

          const mergedMissing = yield* readActiveEntriesForMerge(fs, missingPath, activeVer)
          expect(mergedMissing.size).toBe(0)

          const symlinkPath = WorkspaceFilePath.make(join(dir, "link.json"))
          symlinkSync(cachePath, symlinkPath)
          const symExit = yield* checkNonSymlinkCachePath(fs, symlinkPath, toReadError).pipe(
            Effect.exit,
          )
          match(symExit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              match(Cause.findErrorOption(cause))
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value._tag).toBe("WorkspaceFsError")
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("Expected WorkspaceFsError on symlink cache path"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("Expected symlink check failure"))
            .exhaustive()
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  )
})
