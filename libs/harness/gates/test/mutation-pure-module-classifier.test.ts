import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  collectExcludedLibPureFilesChecked,
  collectPureCandidateFilesChecked,
  discoverAppPureFilesChecked,
  type PureDiscoveredFile,
} from "../src/mutation/mutation-pure-module-classifier.js"
import { readPackageManifest } from "../src/mutation/mutation-target-discovery.js"
import { testHostIo } from "./helpers/test-host-io.js"

const stubMatchesScope = (
  scope: string,
  sDir: string,
  pkgDir: string,
  pkgName: string | undefined,
): boolean => scope === pkgDir || scope === `${sDir}/${pkgDir}` || scope === pkgName

describe("mutation-pure-module-classifier (F-17.3)", () => {
  it("collectPureCandidateFilesChecked handles .tsx / index.tsx multi-hop transitive impurity, type-only isolation, and targetSet", () => {
    const dir = mkdtempSync(join(tmpdir(), "pure-cls-multi-"))
    try {
      const srcDir = join(dir, "libs", "demo", "inf", "src")
      mkdirSync(join(srcDir, "sub"), { recursive: true })

      writeFileSync(
        join(srcDir, "sub", "leaf-io.ts"),
        'export const readEnv = () => process.env["PATH"]\n',
        "utf8",
      )
      writeFileSync(
        join(srcDir, "sub", "index.tsx"),
        'import { readEnv } from "./leaf-io.js"\nexport const subVal = () => readEnv()\n',
        "utf8",
      )
      writeFileSync(
        join(srcDir, "hop2.ts"),
        'import { subVal } from "./sub"\nexport const hop2 = () => subVal()\n',
        "utf8",
      )
      writeFileSync(
        join(srcDir, "hop3.tsx"),
        'import { hop2 } from "./hop2.js"\nexport const Comp = () => String(hop2())\n',
        "utf8",
      )
      writeFileSync(
        join(srcDir, "type-only-user.ts"),
        'import type { hop2 } from "./hop2.js"\nexport type HopRef = typeof hop2\nexport const pureMath = (a: number, b: number): number => a + b\n',
        "utf8",
      )
      writeFileSync(join(srcDir, "types.d.ts"), "export declare const hidden: string\n", "utf8")
      writeFileSync(
        join(srcDir, "pure.tsx"),
        "export const renderNum = (n: number): number => n + 1\n",
        "utf8",
      )

      const allResults: Array<PureDiscoveredFile> = []
      const err = collectPureCandidateFilesChecked({
        dir: srcDir,
        repoRoot: dir,
        scope: "demo",
        pkgDir: "inf",
        pkgName: "@demo/inf",
        tier: "infra-pure",
        targetSet: undefined,
        hostIo: testHostIo,
        results: allResults,
      })
      expect(err).toBeUndefined()
      expect(allResults.map((r) => r.relFile)).toEqual([
        "libs/demo/inf/src/pure.tsx",
        "libs/demo/inf/src/type-only-user.ts",
      ])
      expect(allResults.every((r) => r.tier === "infra-pure")).toBe(true)

      const targeted: Array<PureDiscoveredFile> = []
      const targetErr = collectPureCandidateFilesChecked({
        dir: srcDir,
        repoRoot: dir,
        scope: "demo",
        pkgDir: "inf",
        pkgName: "@demo/inf",
        tier: "infra-pure",
        targetSet: new Set(["libs/demo/inf/src/pure.tsx"]),
        hostIo: testHostIo,
        results: targeted,
      })
      expect(targetErr).toBeUndefined()
      expect(targeted.map((r) => r.relFile)).toEqual(["libs/demo/inf/src/pure.tsx"])

      const missingResults: Array<PureDiscoveredFile> = []
      expect(
        collectPureCandidateFilesChecked({
          dir: join(dir, "libs", "demo", "missing", "src"),
          repoRoot: dir,
          scope: "demo",
          pkgDir: "missing",
          pkgName: undefined,
          tier: "infra-pure",
          targetSet: undefined,
          hostIo: testHostIo,
          results: missingResults,
        }),
      ).toBeUndefined()
      expect(missingResults).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("collectPureCandidateFilesChecked fails closed on symlinks and I/O errors (existsSync, readdirSync, readTextSync)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pure-cls-io-"))
    try {
      const srcDir = join(dir, "libs", "demo", "inf", "src")
      const subDir = join(srcDir, "nested")
      mkdirSync(subDir, { recursive: true })
      const leafFile = join(subDir, "leaf.ts")
      writeFileSync(leafFile, "export const x = 1\n", "utf8")

      const dirSymIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === subDir ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      expect(
        collectPureCandidateFilesChecked({
          dir: srcDir,
          repoRoot: dir,
          scope: "demo",
          pkgDir: "inf",
          pkgName: undefined,
          tier: "infra-pure",
          targetSet: undefined,
          hostIo: dirSymIo,
          results: [],
        }),
      ).toContain("Refusing symlink entry")

      const fileSymIo: SyncHostIo = {
        ...testHostIo,
        isSymbolicLinkSync: (p) => (p === leafFile ? true : testHostIo.isSymbolicLinkSync(p)),
      }
      expect(
        collectPureCandidateFilesChecked({
          dir: srcDir,
          repoRoot: dir,
          scope: "demo",
          pkgDir: "inf",
          pkgName: undefined,
          tier: "infra-pure",
          targetSet: undefined,
          hostIo: fileSymIo,
          results: [],
        }),
      ).toContain("Refusing symlink entry")

      const existsFailIo: SyncHostIo = {
        ...testHostIo,
        existsSync: () => {
          throw new Error("stat EIO")
        },
      }
      expect(
        collectPureCandidateFilesChecked({
          dir: srcDir,
          repoRoot: dir,
          scope: "demo",
          pkgDir: "inf",
          pkgName: undefined,
          tier: "infra-pure",
          targetSet: undefined,
          hostIo: existsFailIo,
          results: [],
        }),
      ).toContain("stat EIO")

      const readdirFailIo: SyncHostIo = {
        ...testHostIo,
        readdirSync: () => {
          throw new Error("readdir EACCES")
        },
      }
      expect(
        collectPureCandidateFilesChecked({
          dir: srcDir,
          repoRoot: dir,
          scope: "demo",
          pkgDir: "inf",
          pkgName: undefined,
          tier: "infra-pure",
          targetSet: undefined,
          hostIo: readdirFailIo,
          results: [],
        }),
      ).toContain("readdir EACCES")

      const readFailIo: SyncHostIo = {
        ...testHostIo,
        readTextSync: () => {
          throw new Error("readText EIO")
        },
      }
      expect(
        collectPureCandidateFilesChecked({
          dir: srcDir,
          repoRoot: dir,
          scope: "demo",
          pkgDir: "inf",
          pkgName: undefined,
          tier: "infra-pure",
          targetSet: undefined,
          hostIo: readFailIo,
          results: [],
        }),
      ).toContain("readText EIO")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("discoverAppPureFilesChecked handles missing/symlink/unreadable apps dir, CorruptManifest, Missing, scope:web/fixture, and non-type:app", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "pure-apps-empty-"))
    try {
      const res: Array<PureDiscoveredFile> = []
      expect(
        discoverAppPureFilesChecked({
          repoRoot: emptyDir,
          scope: undefined,
          targetSet: undefined,
          hostIo: testHostIo,
          readPackageManifest,
          matchesScopeFilter: stubMatchesScope,
          results: res,
        }),
      ).toBeUndefined()
      expect(res).toEqual([])
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }

    const dir = mkdtempSync(join(tmpdir(), "pure-apps-matrix-"))
    try {
      const appsDir = join(dir, "apps")
      const writeApp = (name: string, pkgJson: string | null, srcBody: string): void => {
        const src = join(appsDir, name, "src")
        mkdirSync(src, { recursive: true })
        if (pkgJson !== null) {
          writeFileSync(join(appsDir, name, "package.json"), pkgJson, "utf8")
        }
        writeFileSync(join(src, "pure.ts"), srcBody, "utf8")
      }

      writeApp(
        "cli-ok",
        JSON.stringify({ name: "cli-ok", nx: { tags: ["type:app"] } }),
        "export const ok = (x: number) => x + 1\n",
      )
      writeApp(
        "web-skip",
        JSON.stringify({ name: "web-skip", nx: { tags: ["type:app", "scope:web"] } }),
        "export const w = 1\n",
      )
      writeApp(
        "fix-skip",
        JSON.stringify({ name: "fix-skip", nx: { tags: ["type:app", "scope:fixture"] } }),
        "export const fx = 1\n",
      )
      writeApp(
        "nonapp-skip",
        JSON.stringify({ name: "nonapp-skip", nx: { tags: ["type:infra"] } }),
        "export const na = 1\n",
      )
      writeApp("missing-manifest", null, "export const mm = 1\n")

      const results: Array<PureDiscoveredFile> = []
      expect(
        discoverAppPureFilesChecked({
          repoRoot: dir,
          scope: undefined,
          targetSet: undefined,
          hostIo: testHostIo,
          readPackageManifest,
          matchesScopeFilter: stubMatchesScope,
          results,
        }),
      ).toBeUndefined()
      expect(results.map((r) => r.relFile)).toEqual(["apps/cli-ok/src/pure.ts"])

      const scopedOut: Array<PureDiscoveredFile> = []
      expect(
        discoverAppPureFilesChecked({
          repoRoot: dir,
          scope: "other-app",
          targetSet: undefined,
          hostIo: testHostIo,
          readPackageManifest,
          matchesScopeFilter: stubMatchesScope,
          results: scopedOut,
        }),
      ).toBeUndefined()
      expect(scopedOut).toEqual([])

      expect(
        discoverAppPureFilesChecked({
          repoRoot: dir,
          scope: undefined,
          targetSet: undefined,
          hostIo: {
            ...testHostIo,
            isSymbolicLinkSync: (p) => (p === appsDir ? true : testHostIo.isSymbolicLinkSync(p)),
          },
          readPackageManifest,
          matchesScopeFilter: stubMatchesScope,
          results: [],
        }),
      ).toContain("Refusing symlink entry")

      expect(
        discoverAppPureFilesChecked({
          repoRoot: dir,
          scope: undefined,
          targetSet: undefined,
          hostIo: {
            ...testHostIo,
            existsSync: () => {
              throw new Error("apps stat failed")
            },
          },
          readPackageManifest,
          matchesScopeFilter: stubMatchesScope,
          results: [],
        }),
      ).toContain("apps stat failed")

      expect(
        discoverAppPureFilesChecked({
          repoRoot: dir,
          scope: undefined,
          targetSet: undefined,
          hostIo: {
            ...testHostIo,
            readdirSync: () => {
              throw new Error("apps readdir failed")
            },
          },
          readPackageManifest,
          matchesScopeFilter: stubMatchesScope,
          results: [],
        }),
      ).toContain("apps readdir failed")

      writeApp("corrupt-app", "{broken-json", "export const c = 1\n")
      expect(
        discoverAppPureFilesChecked({
          repoRoot: dir,
          scope: undefined,
          targetSet: undefined,
          hostIo: testHostIo,
          readPackageManifest,
          matchesScopeFilter: stubMatchesScope,
          results: [],
        }),
      ).toContain("Malformed JSON")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("collectExcludedLibPureFilesChecked classifies type:app under libs/ as app-pure, type:infra as infra-pure, and skips fixture/web/service", () => {
    const dir = mkdtempSync(join(tmpdir(), "pure-excluded-lib-"))
    try {
      const libApp = join(dir, "libs", "demo", "lib-app")
      const libInf = join(dir, "libs", "demo", "lib-inf")
      mkdirSync(join(libApp, "src"), { recursive: true })
      mkdirSync(join(libInf, "src"), { recursive: true })
      writeFileSync(join(libApp, "src", "pure.ts"), "export const a = (n: number) => n + 1\n")
      writeFileSync(join(libInf, "src", "codec.ts"), "export const c = (n: number) => n + 1\n")

      const appRes: Array<PureDiscoveredFile> = []
      expect(
        collectExcludedLibPureFilesChecked({
          pkgPath: libApp,
          repoRoot: dir,
          sDir: "demo",
          pkgDir: "lib-app",
          pkgName: "@demo/lib-app",
          tags: ["type:app"],
          scope: undefined,
          targetSet: undefined,
          hostIo: testHostIo,
          matchesScopeFilter: stubMatchesScope,
          results: appRes,
        }),
      ).toBeUndefined()
      expect(appRes).toHaveLength(1)
      expect(appRes[0]?.tier).toBe("app-pure")

      const infRes: Array<PureDiscoveredFile> = []
      expect(
        collectExcludedLibPureFilesChecked({
          pkgPath: libInf,
          repoRoot: dir,
          sDir: "demo",
          pkgDir: "lib-inf",
          pkgName: "@demo/lib-inf",
          tags: ["type:infra"],
          scope: "@demo/lib-inf",
          targetSet: undefined,
          hostIo: testHostIo,
          matchesScopeFilter: stubMatchesScope,
          results: infRes,
        }),
      ).toBeUndefined()
      expect(infRes).toHaveLength(1)
      expect(infRes[0]?.tier).toBe("infra-pure")

      const skipped: Array<PureDiscoveredFile> = []
      for (const tags of [
        ["type:service"],
        ["type:infra", "scope:fixture"],
        ["type:app", "scope:web"],
        ["type:app", "scope:fixture"],
      ]) {
        expect(
          collectExcludedLibPureFilesChecked({
            pkgPath: libApp,
            repoRoot: dir,
            sDir: "demo",
            pkgDir: "lib-app",
            pkgName: "@demo/lib-app",
            tags,
            scope: undefined,
            targetSet: undefined,
            hostIo: testHostIo,
            matchesScopeFilter: stubMatchesScope,
            results: skipped,
          }),
        ).toBeUndefined()
      }
      expect(
        collectExcludedLibPureFilesChecked({
          pkgPath: libInf,
          repoRoot: dir,
          sDir: "demo",
          pkgDir: "lib-inf",
          pkgName: "@demo/lib-inf",
          tags: ["type:infra"],
          scope: "unrelated",
          targetSet: undefined,
          hostIo: testHostIo,
          matchesScopeFilter: stubMatchesScope,
          results: skipped,
        }),
      ).toBeUndefined()
      expect(skipped).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
