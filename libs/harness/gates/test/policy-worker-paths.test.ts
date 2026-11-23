import { describe, expect, it } from "@effect/vitest"
import {
  classifyWorkerFileAccess,
  isProtectedDotHarnessInspectArg,
  isWorkerDaemonCredentialFilePath,
  matchesWorkerDaemonCredentialText,
} from "../src/policy-worker-paths.js"

describe("policy-worker-paths (F-17.2)", () => {
  it("isProtectedDotHarnessInspectArg detects protected .git/.harness inspection targets while allowing workflow-worktrees and benign files", () => {
    for (const deniedArg of [
      ".harness",
      "./.harness/",
      "foo/.harness/",
      ".git",
      "repo/.git/",
      ".git/harness/daemon.sock",
      ".git/worktrees/wt1",
      ".git/work\\trees/wt1",
      ".git/[w]orktrees",
      ".harness/omnigraph-cluster",
      ".harness/omni*",
      ".harness/[a-z]ache",
    ]) {
      expect(isProtectedDotHarnessInspectArg(deniedArg), deniedArg).toBe(true)
    }

    for (const allowedArg of [
      ".harness/workflow-worktrees/run-1/unit-a/libs/a.ts",
      ".git/config",
      "libs/harness/gates/src/policy.ts",
    ]) {
      expect(isProtectedDotHarnessInspectArg(allowedArg), allowedArg).toBe(false)
    }
  })

  it("matchesWorkerDaemonCredentialText detects credential patterns across backslash paths, quotes, braces, and brackets", () => {
    expect(matchesWorkerDaemonCredentialText("")).toBe(false)

    for (const badText of [
      "cat .harness\\omnigraph-cluster\\auth-tokens.json",
      "curl --unix-socket '.git/harness/daemon.sock'",
      "ls {a,auth-tokens.json}",
      "ls [.git/harness/daem[o]n.sock]",
      "SOCK=daem[o]n.sock",
      "TOKEN=omni[g]raph-cluster",
    ]) {
      expect(matchesWorkerDaemonCredentialText(badText), badText).toBe(true)
    }

    expect(matchesWorkerDaemonCredentialText("vitest run libs/harness/gates")).toBe(false)
    expect(matchesWorkerDaemonCredentialText("cat libs/harness/domain/src/daemon-model.ts")).toBe(
      false,
    )
  })

  it("isWorkerDaemonCredentialFilePath and classifyWorkerFileAccess enforce unitWorkerMode and traversal normalization", () => {
    expect(isWorkerDaemonCredentialFilePath("")).toBe(false)
    expect(isWorkerDaemonCredentialFilePath("   ")).toBe(false)

    for (const sensitivePath of [
      ".harness/omnigraph-cluster/auth-tokens.json",
      ".git\\harness\\daemon.sock",
      "nested/../auth-tokens.json",
      ".git/worktrees/wt-1/HEAD",
      "sub/dae[m]on.sock",
    ]) {
      expect(isWorkerDaemonCredentialFilePath(sensitivePath), sensitivePath).toBe(true)
      expect(classifyWorkerFileAccess(sensitivePath, false)).toEqual({ verdict: "allow" })
      expect(classifyWorkerFileAccess(sensitivePath, true)).toEqual({
        verdict: "deny",
        ruleId: "worker-daemon-credential-access",
        reason: expect.stringContaining("HARNESS_UNIT_WORKER=1"),
      })
    }

    expect(
      classifyWorkerFileAccess(".harness/workflow-worktrees/run-1/unit-a/src/a.ts", true),
    ).toEqual({ verdict: "allow" })
  })
})
