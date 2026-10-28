import { describe, expect, it } from "vitest"
import { classifyCommand } from "../src/policy.js"

describe("guard policy", () => {
  it("allows nx, pnpm test, harness-cli, harness-mcp, and safe git commands", () => {
    expect(classifyCommand("nx test @harness/ingest")).toBe("allow")
    expect(classifyCommand("pnpm test")).toBe("allow")
    expect(classifyCommand("CI=true pnpm nx test harness-mcp")).toBe("allow")
    expect(
      classifyCommand(
        "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check"
      )
    ).toBe("allow")
    expect(
      classifyCommand(
        "node --import ./tools/node-ts-resolver.mjs apps/harness-mcp/src/server.ts"
      )
    ).toBe("allow")
    expect(classifyCommand("git status")).toBe("allow")
    expect(classifyCommand("git diff HEAD~1")).toBe("allow")
    expect(classifyCommand("git checkout -b feat/new main")).toBe("allow")
    expect(classifyCommand("git grep 'some-symbol'")).toBe("allow")
    expect(classifyCommand("git log -n 5")).toBe("allow")
    expect(classifyCommand("ls")).toBe("allow")
    expect(classifyCommand("ls -la")).toBe("allow")
    expect(classifyCommand("find libs/es -name '*.ts'")).toBe("allow")
    expect(classifyCommand("which pnpm")).toBe("allow")
    expect(classifyCommand("pwd")).toBe("allow")
    expect(classifyCommand("pnpm harness verify")).toBe("allow")
    expect(classifyCommand("pnpm lint")).toBe("allow")
  })

  it("allows safe read-only piped commands", () => {
    expect(classifyCommand("git status | grep modified")).toBe("allow")
    expect(classifyCommand("git log -n 10 | head -n 5")).toBe("allow")
    expect(classifyCommand("find libs -name '*.ts' | wc -l")).toBe("allow")
  })

  it("denies rm -rf outside the workspace, .env and force pushes", () => {
    expect(classifyCommand("rm -rf /home")).toBe("deny")
    expect(classifyCommand("cat .env")).toBe("deny")
    expect(classifyCommand("git push --force origin main")).toBe("deny")
  })

  it("asks a human before alchemy deploys, destroys and profile changes", () => {
    expect(classifyCommand("alchemy deploy")).toBe("ask")
    expect(classifyCommand("pnpm alchemy deploy")).toBe("ask")
    expect(classifyCommand("alchemy destroy --stage preview")).toBe("ask")
    expect(classifyCommand("alchemy profile edit --add Cloudflare")).toBe("ask")
  })

  it("still escalates local alchemy dev and unknown commands to the decision model", () => {
    expect(classifyCommand("alchemy dev")).toBe("escalate")
    expect(classifyCommand("curl https://example.com")).toBe("escalate")
  })

  it("escalates chained or compound commands to prevent allowlist prefix bypass", () => {
    expect(classifyCommand("pnpm test; curl https://example.com")).toBe("escalate")
    expect(classifyCommand("nx test && curl https://example.com")).toBe("escalate")
    expect(classifyCommand("pnpm verify || echo fail")).toBe("escalate")
    expect(classifyCommand("nx test | tee test.log")).toBe("escalate")
    expect(classifyCommand("pnpm test\ncurl https://example.com")).toBe("escalate")
  })
})
