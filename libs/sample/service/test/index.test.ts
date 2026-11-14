import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  AlbumId,
  AlbumPhotoCount,
  CreatedAtMillis,
  PhotoId,
  PhotoName,
} from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "../src/index.js"

describe("PhotoRepo", () => {
  it.effect("can be provided and accessed via Context", () =>
    Effect.gen(function* () {
      const dummyPhoto = {
        id: PhotoId.make(1),
        name: PhotoName.make("Sunset"),
        albumId: AlbumId.make("a1"),
        createdAt: CreatedAtMillis.make(12345),
      }
      const repoImpl = {
        insert: () => Effect.succeed(dummyPhoto),
        findById: () => Effect.succeed(dummyPhoto),
        listAll: Effect.succeed([dummyPhoto]),
      }
      const program = Effect.gen(function* () {
        const repo = yield* PhotoRepo
        const inserted = yield* repo.insert({
          name: PhotoName.make("Sunset"),
          albumId: AlbumId.make("a1"),
        })
        const found = yield* repo.findById(PhotoId.make(1))
        const all = yield* repo.listAll
        return { inserted, found, all }
      }).pipe(Effect.provideService(PhotoRepo, repoImpl))

      const result = yield* program
      expect(result.inserted).toEqual(dummyPhoto)
      expect(result.found).toEqual(dummyPhoto)
      expect(result.all).toEqual([dummyPhoto])
    }),
  )
})

describe("AlbumCounterClient", () => {
  it.effect("can be provided and accessed via Context", () =>
    Effect.gen(function* () {
      const clientImpl = {
        increment: () => Effect.succeed(AlbumPhotoCount.make(1)),
        getCount: () => Effect.succeed(AlbumPhotoCount.make(0)),
      }
      const program = Effect.gen(function* () {
        const client = yield* AlbumCounterClient
        const count = yield* client.getCount(AlbumId.make("a1"))
        const next = yield* client.increment(AlbumId.make("a1"))
        return { count, next }
      }).pipe(Effect.provideService(AlbumCounterClient, clientImpl))

      const result = yield* program
      expect(result.count).toBe(0)
      expect(result.next).toBe(1)
    }),
  )
})

describe("Effect language-service & oxlint gates (TS377091 lazyEffect)", () => {
  it("rejects zero-argument () => Effect service members and oxlint-disable effecttsgo/* suppressions", async () => {
    const { spawnSync } = await import("node:child_process")
    const { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join, resolve } = await import("node:path")
    const { fileURLToPath } = await import("node:url")

    const currentDir = import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url))
    const repoRoot = resolve(currentDir, "../../../..")
    const tempRoot = mkdtempSync(join(tmpdir(), "harness-lazy-effect-"))
    const tempSrcDir = join(tempRoot, "libs", "sample", "service", "src")
    const tempFile = join(tempSrcDir, "__temp_lazy_effect_check__.ts")

    try {
      mkdirSync(tempSrcDir, { recursive: true })
      symlinkSync(join(repoRoot, "node_modules"), join(tempRoot, "node_modules"), "dir")
      symlinkSync(
        join(repoRoot, "libs", "sample", "service", "node_modules"),
        join(tempRoot, "libs", "sample", "service", "node_modules"),
        "dir",
      )
      symlinkSync(join(repoRoot, "tools"), join(tempRoot, "tools"), "dir")
      copyFileSync(join(repoRoot, ".oxlintrc.json"), join(tempRoot, ".oxlintrc.json"))
      copyFileSync(join(repoRoot, "tsconfig.base.json"), join(tempRoot, "tsconfig.base.json"))
      copyFileSync(
        join(repoRoot, "libs", "sample", "service", "tsconfig.json"),
        join(tempRoot, "libs", "sample", "service", "tsconfig.json"),
      )

      writeFileSync(
        tempFile,
        [
          'import { Context, type Effect } from "effect"',
          "export class BadRepo extends Context.Service<BadRepo, {",
          "  readonly listAll: () => Effect.Effect<ReadonlyArray<string>>",
          '}>()("BadRepo") {}',
        ].join("\n"),
        "utf8",
      )
      const resLazy = spawnSync(
        "pnpm",
        ["--dir", repoRoot, "exec", "oxlint", "-c", join(tempRoot, ".oxlintrc.json"), "--deny-warnings", tempFile],
        {
          cwd: tempRoot,
          encoding: "utf8",
        },
      )
      expect(resLazy.status).not.toBe(0)
      expect(resLazy.stdout + resLazy.stderr).toContain("lazy-effect")

      writeFileSync(
        tempFile,
        ["// oxlint-disable-next-line effecttsgo/lazy-effect", "export const x = 1"].join("\n"),
        "utf8",
      )
      const resDisable = spawnSync(
        "pnpm",
        ["--dir", repoRoot, "exec", "oxlint", "-c", join(tempRoot, ".oxlintrc.json"), "--deny-warnings", tempFile],
        {
          cwd: tempRoot,
          encoding: "utf8",
        },
      )
      expect(resDisable.status).not.toBe(0)
      expect(resDisable.stdout + resDisable.stderr).toContain("Suppressing `effecttsgo/*`")
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
