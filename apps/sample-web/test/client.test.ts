import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { AtomHttpApi, AtomRegistry } from "effect/reactivity"
import { SampleApi, type Photo } from "@harness/sample-contract"
import {
  SampleApiClient,
  listPhotosAtom,
  getPhotoByIdAtom,
  createPhotoMutation
} from "../src/client.js"
import { execSync } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../../..")

const testPhotos: readonly Photo[] = [
  { id: 1, name: "photo1.jpg", albumId: "vacation", createdAt: 1000 },
  { id: 2, name: "photo2.jpg", albumId: "vacation", createdAt: 2000 }
]

const getExecErrorOutput = (err: unknown): string => {
  if (typeof err === "object" && err !== null) {
    const rec = err as { stdout?: string | Buffer; stderr?: string | Buffer }
    return String(rec.stdout ?? "") + String(rec.stderr ?? "")
  }
  return String(err)
}

describe("SampleApiClient and AtomHttpApi", () => {
  it("exports SampleApiClient and derived query and mutation atoms", () => {
    expect(SampleApiClient).toBeDefined()
    expect(listPhotosAtom).toBeDefined()
    expect(getPhotoByIdAtom).toBeDefined()
    const photo1Atom = getPhotoByIdAtom(1)
    expect(photo1Atom).toBeDefined()
    expect(createPhotoMutation).toBeDefined()
  })

  it("executes typed queries and mutations against SampleApi via AtomRegistry", async () => {
    class MockSampleApiClient extends AtomHttpApi.Service<MockSampleApiClient>()("MockSampleApiClient", {
      api: SampleApi,
      baseUrl: "http://localhost:8787",
      httpClient: Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const url = new URL(request.url)
            if (request.method === "GET" && url.pathname === "/photos") {
              return HttpClientResponse.fromWeb(request, Response.json(testPhotos))
            }
            if (request.method === "GET" && url.pathname === "/photos/1") {
              return HttpClientResponse.fromWeb(request, Response.json(testPhotos[0]))
            }
            if (request.method === "POST" && url.pathname === "/photos") {
              const newPhoto: Photo = {
                id: 3,
                name: "new.jpg",
                albumId: "vacation",
                createdAt: 3000
              }
              return HttpClientResponse.fromWeb(request, Response.json(newPhoto))
            }
            return HttpClientResponse.fromWeb(request, new Response("Not found", { status: 404 }))
          })
        )
      )
    }) {}

    const queryAtom = MockSampleApiClient.query("photos", "listPhotos", {})
    const getAtom = MockSampleApiClient.query("photos", "getPhoto", { params: { id: 1 } })
    const mutation = MockSampleApiClient.mutation("photos", "createPhoto")

    const registry = AtomRegistry.make()
    try {
      const photos = await Effect.runPromise(
        AtomRegistry.getResult(registry, queryAtom, { suspendOnWaiting: true })
      )
      expect(photos).toEqual(testPhotos)

      const single = await Effect.runPromise(
        AtomRegistry.getResult(registry, getAtom, { suspendOnWaiting: true })
      )
      expect(single).toEqual(testPhotos[0])

      registry.set(mutation, { payload: { name: "new.jpg", albumId: "vacation" } })
      const created = await Effect.runPromise(
        AtomRegistry.getResult(registry, mutation, { suspendOnWaiting: true })
      )
      expect(created).toEqual({ id: 3, name: "new.jpg", albumId: "vacation", createdAt: 3000 })
    } finally {
      registry.dispose()
    }
  })

  it("enforces fetch ban in apps/sample-web/src via oxlint", () => {
    const tempFile = path.resolve(__dirname, "../src/temp-fetch-ban-test.ts")
    try {
      fs.writeFileSync(tempFile, 'export const bad = fetch("http://localhost:8787/photos")\n')
      let failed = false
      let output = ""
      try {
        output = execSync("pnpm exec oxlint apps/sample-web/src/temp-fetch-ban-test.ts", {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf-8"
        })
      } catch (err: unknown) {
        failed = true
        output = getExecErrorOutput(err)
      }
      expect(failed).toBe(true)
      expect(output).toMatch(/fetch/i)
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile)
      }
    }
  })

  it("enforces scope:web boundary in apps/sample-web/src via oxlint", () => {
    const tempFile = path.resolve(__dirname, "../src/temp-scope-boundary-test.ts")
    try {
      fs.writeFileSync(
        tempFile,
        'import { greet } from "@harness/sample-domain"\nexport const bad = greet\n'
      )
      let failed = false
      let output = ""
      try {
        output = execSync("pnpm --filter sample-web run lint", {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf-8"
        })
      } catch (err: unknown) {
        failed = true
        output = getExecErrorOutput(err)
      }
      expect(failed).toBe(true)
      expect(output).toMatch(/scope:web|contract/i)
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile)
      }
    }
  })

  it("enforces 5 security and reliability AST bans via oxlint", () => {
    const testCases = [
      {
        file: path.resolve(repoRoot, "apps/sample-web/src/temp-secret-test.ts"),
        code: 'import { Config } from "effect"\nexport const secret = Config.string("API_SECRET")\n',
        match: /Sensitive configuration keys/
      },
      {
        file: path.resolve(repoRoot, "apps/sample-web/src/temp-sql-test.ts"),
        code: "const db = { prepare: (q: string) => q }; const id = 1;\nexport const q = db.prepare(`SELECT * FROM t WHERE id = ${id}`)\n",
        match: /SQL injection risk/
      },
      {
        file: path.resolve(repoRoot, "libs/sample/domain/src/temp-impure-test.ts"),
        code: "export const t = Date.now()\n",
        match: /Impure global/
      },
      {
        file: path.resolve(repoRoot, "apps/sample-web/src/temp-retry-test.ts"),
        code: 'import { Effect, Schedule } from "effect"\nexport const r = Effect.retry(Effect.void, Schedule.forever)\n',
        match: /Unbounded Effect\.retry/
      },
      {
        file: path.resolve(repoRoot, "libs/sample/domain/src/temp-ignore-test.ts"),
        code: 'import { Effect } from "effect"\nexport const ign = Effect.ignore(Effect.void)\n',
        match: /Swallowing typed errors with Effect\.ignore/
      }
    ]

    for (const { file, code, match } of testCases) {
      try {
        fs.writeFileSync(file, code)
        let failed = false
        let output = ""
        try {
          output = execSync(`pnpm exec oxlint ${file}`, {
            cwd: repoRoot,
            stdio: "pipe",
            encoding: "utf-8"
          })
        } catch (err: unknown) {
          failed = true
          output = getExecErrorOutput(err)
        }
        expect(failed).toBe(true)
        expect(output).toMatch(match)
      } finally {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
        }
      }
    }
  })

  it("enforces test-integrity and TypeScript suppression bans via oxlint", () => {
    const testCases = [
      {
        file: path.resolve(repoRoot, "apps/sample-web/test/temp-skip-test.ts"),
        code: 'it.skip("skipped test", () => {})\n',
        match: /Skipping or focusing tests/
      },
      {
        file: path.resolve(repoRoot, "apps/sample-web/test/temp-ts-ignore-test.ts"),
        code: "// @ts-ignore\nexport const x = 1\n",
        match: /TypeScript suppression/
      },
      {
        file: path.resolve(repoRoot, "apps/sample-web/src/temp-ts-expect-error-test.ts"),
        code: "// @ts-expect-error\nexport const y = 2\n",
        match: /TypeScript suppression directives/
      }
    ]

    for (const { file, code, match } of testCases) {
      try {
        fs.writeFileSync(file, code)
        let failed = false
        let output = ""
        try {
          output = execSync(`pnpm exec oxlint ${file}`, {
            cwd: repoRoot,
            stdio: "pipe",
            encoding: "utf-8"
          })
        } catch (err: unknown) {
          failed = true
          output = getExecErrorOutput(err)
        }
        expect(failed).toBe(true)
        expect(output).toMatch(match)
      } finally {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
        }
      }
    }
  })

  it("enforces type-safety bans on any, never, and double type assertions via oxlint", () => {
    const testCases = [
      {
        file: path.resolve(repoRoot, "apps/sample-web/src/temp-any-ban-test.ts"),
        code: "export const x = 1 as" + " any\n",
        match: /Explicit 'any'/
      },
      {
        file: path.resolve(repoRoot, "apps/sample-web/src/temp-never-ban-test.ts"),
        code: "export const y = 1 as" + " never\n",
        match: /Unsafe 'never'/
      },
      {
        file: path.resolve(repoRoot, "apps/sample-web/src/temp-double-cast-ban-test.ts"),
        code: "export const z = 1 as" + " unknown as" + " string\n",
        match: /Double type assertions/
      }
    ]

    for (const { file, code, match } of testCases) {
      try {
        fs.writeFileSync(file, code)
        let failed = false
        let output = ""
        try {
          output = execSync(`pnpm exec oxlint ${file}`, {
            cwd: repoRoot,
            stdio: "pipe",
            encoding: "utf-8"
          })
        } catch (err: unknown) {
          failed = true
          output = getExecErrorOutput(err)
        }
        expect(failed).toBe(true)
        expect(output).toMatch(match)
      } finally {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
        }
      }
    }
  })
})
