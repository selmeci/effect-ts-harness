import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { classifyFileWrite } from "@harness/gates"
import { buildHarnessGraph } from "@harness/graph"
import { runCli } from "../src/index.js"

describe("harness cli plan-synth and repair commands", () => {
  it("rejects plan-synth without spec-id and prints usage", async () => {
    const res = await runCli(["plan-synth"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("usage: harness plan-synth <spec-id>")
  })

  it("executes plan-synth <spec-id> against a graph with an EarsSpec and enforces exact spec-id boundary matching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-plan-synth-"))
    try {
      const planGraph = buildHarnessGraph({
        earsSpecs: [
          {
            id: "order:SPEC-0001",
            title: "Order Placement Spec",
            status: "proposed",
            path: "libs/order/docs/specs/0001-order.md",
            enforcedByFiles: ["libs/order/domain/src/order.ts"],
            referencedSpans: ["Order.placeOrder"],
            referencedServices: ["OrderService"],
            referencedErrors: ["OrderRejectedError"],
          },
        ],
      })

      // Substring prefix "order:SPEC-000" must NOT match "order:SPEC-0001"
      const prefixMismatchRes = await runCli(["plan-synth", "order:SPEC-000"], {
        repoRoot: dir,
        implGraph: planGraph,
      })
      expect(prefixMismatchRes.exitCode).toBe(1)
      expect(prefixMismatchRes.stderr).toContain("No plan-synth patches matched specification")

      const res = await runCli(["plan-synth", "order:SPEC-0001"], {
        repoRoot: dir,
        implGraph: planGraph,
      })

      expect(res.exitCode).toBe(0)
      const payload = JSON.parse(res.stdout) as {
        readonly specId: string
        readonly mode: string
        readonly patchCount: number
        readonly overlayCount: number
        readonly verificationStatus: string
        readonly roundTripVerified: boolean
        readonly overlays: ReadonlyArray<{ readonly targetFile: string; readonly content: string }>
      }

      expect(payload.specId).toBe("order:SPEC-0001")
      expect(payload.mode).toBe("auto-plan")
      expect(payload.patchCount).toBeGreaterThan(0)
      expect(payload.overlayCount).toBeGreaterThan(0)
      expect(payload.verificationStatus).toBe("Unverified")
      expect(payload.roundTripVerified).toBe(false)
      expect(Array.isArray(payload.overlays)).toBe(true)

      // Test with --write flag (automatically enables round-trip verification)
      const writeRes = await runCli(["plan-synth", "order:SPEC-0001", "--write"], {
        repoRoot: dir,
        implGraph: planGraph,
      })
      expect(writeRes.exitCode).toBe(0)
      const writePayload = JSON.parse(writeRes.stdout) as {
        readonly written: boolean
        readonly verificationStatus: string
        readonly roundTripVerified: boolean
        readonly writtenFiles: ReadonlyArray<string>
      }
      expect(writePayload.written).toBe(true)
      expect(writePayload.verificationStatus).toBe("Verified")
      expect(writePayload.roundTripVerified).toBe(true)
      expect(writePayload.writtenFiles.length).toBeGreaterThan(0)
      for (const writtenFile of writePayload.writtenFiles) {
        const fullPath = join(dir, writtenFile)
        expect(existsSync(fullPath)).toBe(true)
        const fileContent = readFileSync(fullPath, "utf-8")
        expect(fileContent.length).toBeGreaterThan(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("executes repair --rule REP-05 against an existing file and fails closed on missing files or unmatched rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-repair-"))
    try {
      const untracedGraph = buildHarnessGraph({
        fns: [
          {
            qualname: "libs/sample/domain/src/order.ts#decideUntraced",
            spanName: "untraced",
            file: "libs/sample/domain/src/order.ts",
            line: 1,
            packageTag: "domain",
            successType: "void",
            isStub: false,
          },
        ],
      })

      // 1. When target file does not exist on disk, repair fails closed with exitCode 1
      const missingFileRes = await runCli(["repair", "--rule", "REP-05"], {
        repoRoot: dir,
        implGraph: untracedGraph,
      })
      expect(missingFileRes.exitCode).toBe(1)
      expect(missingFileRes.stderr).toContain("missing-target-file")

      // 2. Create target file on disk and verify repair succeeds
      const orderDir = join(dir, "libs/sample/domain/src")
      mkdirSync(orderDir, { recursive: true })
      writeFileSync(
        join(orderDir, "order.ts"),
        "export const decideUntraced = Effect.fnUntraced(() => Effect.void)\n",
        "utf-8",
      )

      const res = await runCli(["repair", "--rule", "REP-05"], {
        repoRoot: dir,
        implGraph: untracedGraph,
      })

      expect(res.exitCode).toBe(0)
      const payload = JSON.parse(res.stdout) as {
        readonly mode: string
        readonly ruleFilter: string
        readonly patchCount: number
        readonly overlayCount: number
        readonly verificationStatus: string
        readonly operations: ReadonlyArray<unknown>
      }

      expect(payload.mode).toBe("auto-repair")
      expect(payload.ruleFilter).toBe("REP-05")
      expect(payload.patchCount).toBeGreaterThan(0)
      expect(payload.verificationStatus).toBe("Unverified")
      expect(Array.isArray(payload.operations)).toBe(true)

      // Also test --rule=REP-05 syntax
      const resEq = await runCli(["repair", "--rule=REP-05"], {
        repoRoot: dir,
        implGraph: untracedGraph,
      })
      expect(resEq.exitCode).toBe(0)
      expect(JSON.parse(resEq.stdout).ruleFilter).toBe("REP-05")

      // 3. Unmatched rule filter exits 1 with stderr diagnostic
      const unmatchedRuleRes = await runCli(["repair", "--rule", "REP-99"], {
        repoRoot: dir,
        implGraph: untracedGraph,
      })
      expect(unmatchedRuleRes.exitCode).toBe(1)
      expect(unmatchedRuleRes.stderr).toContain("No repair patches matched rule filter 'REP-99'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("enforces classifyFileWrite verdict === 'allow' so 'ask' governance files are never overwritten", () => {
    expect(classifyFileWrite(".oxlintrc.json").verdict).toBe("ask")
    expect(classifyFileWrite("tools/oxlint/syntax-bans.js").verdict).toBe("ask")
    expect(classifyFileWrite("policies.cedar").verdict).toBe("ask")
    expect(classifyFileWrite("libs/harness/gates/src/policies.cedar").verdict).toBe("ask")
    expect(classifyFileWrite("repos/effect/package.json").verdict).toBe("deny")
    expect(classifyFileWrite("libs/order/domain/src/order.ts").verdict).toBe("allow")
  })
})
