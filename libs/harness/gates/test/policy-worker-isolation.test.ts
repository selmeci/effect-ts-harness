import { describe, expect, it } from "vitest"
import {
  classifyCommand,
  classifyFileRead,
  classifyFileWrite,
  classifyWorkerFileAccess,
  explainCommandDenyReason,
  explainCommandDenyRule,
  isWorkerDaemonCredentialShellAccess,
  isWorkerRecursiveWorkflowCommand,
  MAX_SUBSHELL_INSPECT_DEPTH,
  type FileWriteDenyRuleId,
} from "../src/policy.js"
import { classifyWorkerFileAccess as classifyWorkerFileAccessFromFastpath } from "../src/hook-fastpath.js"
import { classifyWorkerFileAccess as classifyWorkerFileAccessFromIndex } from "../src/index.js"

describe("worker isolation and workflow worktree policy", () => {
  it("F-1.1 allows normal source edits inside .harness/workflow-worktrees/<runId>/<unitId>/** while denying stamps, commonGitDir harness state, repos/**, and secret files", () => {
    expect(classifyFileWrite(".harness/workflow-worktrees/run-1/unit-a/libs/a.ts").verdict).toBe(
      "allow",
    )
    expect(
      classifyFileWrite("/repo/.harness/workflow-worktrees/run-1/unit-a/libs/a.ts", {
        unitWorkerMode: true,
      }).verdict,
    ).toBe("allow")
    expect(classifyFileRead(".harness/workflow-worktrees/run-1/unit-a/libs/a.ts").verdict).toBe(
      "allow",
    )

    const worktreeDeniedWrites: ReadonlyArray<{
      readonly path: string
      readonly ruleId: FileWriteDenyRuleId
    }> = [
      {
        path: ".harness/workflow-worktrees/run-1/unit-a/.harness/verify-stamp.json",
        ruleId: "verify-stamp",
      },
      {
        path: ".harness/workflow-worktrees/run-1/unit-a/.harness/worktrees/unit-a/verify-stamp.json",
        ruleId: "verify-stamp",
      },
      {
        path: ".harness/workflow-worktrees/run-1/unit-a/.harness/mutate-stamp.json",
        ruleId: "mutate-stamp",
      },
      {
        path: ".harness/workflow-worktrees/run-1/unit-a/repos/effect/LLMS.md",
        ruleId: "readonly-subtree",
      },
      {
        path: ".harness/workflow-worktrees/run-1/unit-a/.env",
        ruleId: "secret-file",
      },
      {
        path: ".harness/workflow-worktrees/run-1/unit-a/.git/harness/daemon.sock",
        ruleId: "harness-common-dir-state",
      },
      {
        path: "/repo/.git/harness/daemon.lock",
        ruleId: "harness-common-dir-state",
      },
      {
        path: "/repo/.git/harness/workflow-backups/2026-11-20.ndjson",
        ruleId: "harness-common-dir-state",
      },
      {
        path: "/repo/.git/harness/auth-tokens.json",
        ruleId: "harness-common-dir-state",
      },
    ]
    for (const c of worktreeDeniedWrites) {
      const res = classifyFileWrite(c.path)
      expect(res.verdict, c.path).toBe("deny")
      expect(res.ruleId, c.path).toBe(c.ruleId)
    }
  })

  it("F-4.1 denies secret files and protected <commonGitDir>/harness/** reads in classifyFileRead across all modes", () => {
    for (const p of [
      ".env",
      ".env.local",
      ".env.production",
      ".dev.vars",
      "mutation-hmac-v2.key",
      "private.pem",
      ".cache/effect-harness/mutation-hmac-v2.key",
      ".harness/workflow-worktrees/run-1/unit-a/.env",
    ]) {
      const res = classifyFileRead(p)
      expect(res.verdict, p).toBe("deny")
      expect(res.ruleId, p).toBe("secret-file")
    }

    for (const p of [
      ".git/harness/daemon.sock",
      ".git/harness/daemon.lock",
      ".git/harness/workflow-backups/2026-11-20.ndjson",
      ".git/harness/auth-tokens.json",
      "/repo/.harness/omnigraph-cluster/auth-tokens.json",
      "daemon.sock",
    ]) {
      const res = classifyFileRead(p, { unitWorkerMode: false })
      expect(res.verdict, p).toBe("deny")
      expect(res.ruleId, p).toBe("harness-common-dir-state")
    }

    for (const allowed of [
      "libs/harness/contract/src/workflow.ts",
      "repos/effect/LLMS.md",
      ".env.example",
      ".env.template",
      ".env.sample",
      ".harness/workflow-worktrees/run-1/unit-a/libs/a.ts",
    ]) {
      expect(classifyFileRead(allowed).verdict, allowed).toBe("allow")
    }
  })

  it("REQ-4.6 / F-3.4 blocks recursive workflow orchestration, doctor, complete --phase llm, and harness done under HARNESS_UNIT_WORKER=1", () => {
    const recursiveDenied: ReadonlyArray<string> = [
      "harness done",
      "pnpm harness done",
      "pnpm run harness done",
      "pnpm exec harness done",
      "npx harness done",
      "pnpx harness workflow start",
      "bunx harness workflow resume",
      "bun harness workflow abort",
      "yarn harness workflow done",
      "npm exec harness -- workflow start",
      "harness --cwd /tmp workflow start",
      "harness --cwd=/tmp -- done",
      "harness workflow --json --run-id r1 resume",
      "harness workflow --run-id=r1 abort",
      "harness workflow -- start",
      "harness workflow doctor",
      "pnpm harness workflow doctor --rebuild-views",
      "pnpm harness workflow complete --run-id r1 --unit u1 --phase llm",
      "harness workflow complete --phase=llm",
      "harness workflow --phase llm complete",
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts workflow start",
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done",
      "tsx apps/harness-cli/src/index.ts workflow resume",
      "bun apps/harness-cli/src/index.ts workflow abort",
      "node -- apps/harness-cli/src/index.ts workflow done",
      "HARNESS_UNIT_WORKER=1 env -u FOO timeout 10 pnpm harness workflow start",
      "pnpm test && pnpm harness workflow start",
      "nx run @harness/gates:verify; harness done",
      "echo ok | pnpm harness workflow abort",
      "pnpm harness \\\n  workflow start",
      "echo $(pnpm harness done)",
      'echo "$(echo $(harness workflow start))"',
      "echo `npx harness workflow resume`",
      'sh -c "pnpm harness workflow abort"',
      "bash -lc 'harness done'",
      "bash -c -l 'pnpm harness workflow start'",
      "bash -c -- 'pnpm harness done'",
      'eval "harness workflow start"',
      'git commit -m "fix $(harness done)"',
      "pnpm --filter harness-cli start workflow start",
      "pnpm --filter=harness-cli start workflow resume",
      "pnpm -F harness-cli start done",
      "pnpm --filter @harness/harness-cli run start -- workflow abort",
      "pnpm --filter harness-cli exec node src/index.ts workflow start",
      "tsx --tsconfig tsconfig.base.json apps/harness-cli/src/index.ts workflow start",
      "node --env-file-if-exists .env.example --watch-path apps --diagnostic-dir /tmp --redirect-warnings /tmp/w apps/harness-cli/src/index.ts workflow done",
      "deno run --allow-all apps/harness-cli/src/index.ts workflow start",
      "deno --config deno.json run apps/harness-cli/src/index.ts done",
      "cat <(pnpm harness workflow start)",
      "tee >(pnpm harness done)",
    ]
    for (const cmd of recursiveDenied) {
      expect(isWorkerRecursiveWorkflowCommand(cmd), cmd).toBe(true)
      expect(classifyCommand(cmd, { unitWorkerMode: true }), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd, { unitWorkerMode: true })?.ruleId, cmd).toBe(
        "worker-recursive-workflow-command",
      )
      expect(explainCommandDenyReason(cmd, { unitWorkerMode: true }), cmd).toContain(
        "HARNESS_UNIT_WORKER=1",
      )
    }
  })

  it("F-3.3 / F-23.5 blocks nx run harness-cli:start, pnpm --filter @harness/cli start, pnpm exec, extra -- separators, and xargs/exec/env/command wrappers under HARNESS_UNIT_WORKER=1", () => {
    const bypassDenied: ReadonlyArray<string> = [
      "nx run harness-cli:start -- workflow abort",
      "nx run harness-cli:start -- workflow start",
      "nx run harness-cli:start -- workflow resume",
      "nx run harness-cli:start -- workflow doctor",
      "nx run harness-cli:start -- workflow complete --phase llm",
      "pnpm nx run harness-cli:start -- workflow abort",
      "pnpm nx run @harness/cli:start -- done",
      "nx start harness-cli -- workflow start",
      "pnpm --filter @harness/cli start workflow start",
      "pnpm --filter=@harness/cli start workflow doctor",
      "pnpm --filter ...harness-cli start workflow abort",
      "pnpm --filter @harness/cli exec node src/index.ts workflow complete --phase=llm",
      "pnpm exec node apps/harness-cli/src/index.ts workflow start",
      "pnpm exec tsx apps/harness-cli/src/index.ts done",
      "node apps/harness-cli/src/index.ts -- workflow start",
      "node apps/harness-cli/src/index.ts -- -- workflow abort",
      "harness -- done",
      "harness -- -- workflow start",
      "harness workflow -- -- doctor",
      "xargs harness done",
      "echo workflow start | xargs harness",
      "echo start | xargs -I{} pnpm harness workflow {}",
      "printf 'done\\n' | xargs -n 1 harness",
      "cat cmds.txt | xargs harness",
      "exec harness workflow start",
      "exec -a custom pnpm --filter @harness/cli start workflow abort",
      "env -v harness done",
      "env -C apps/harness-cli node src/index.ts workflow start",
      "command -p harness workflow doctor",
      "exec env -v pnpm exec harness workflow complete --phase llm",
    ]
    for (const cmd of bypassDenied) {
      expect(isWorkerRecursiveWorkflowCommand(cmd), cmd).toBe(true)
      expect(classifyCommand(cmd, { unitWorkerMode: true }), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd, { unitWorkerMode: true })?.ruleId, cmd).toBe(
        "worker-recursive-workflow-command",
      )
    }
  })

  it("F-3.3 / F-23.5 blocks shell variable indirection and eval targeting workflow orchestration or daemon credentials under HARNESS_UNIT_WORKER=1", () => {
    for (const cmd of [
      "CMD=harness; $CMD workflow start",
      'CMD="pnpm harness"; ${CMD} done',
      "ACT=doctor; harness workflow $ACT",
      'export CMD="nx run harness-cli:start -- workflow abort"; $CMD',
      'CMD="harness workflow start"; eval "$CMD"',
      "eval -- 'harness done'",
      'eval "$EXTERNAL_CMD"',
      "harness $UNKNOWN_SUB",
      "harness workflow $UNKNOWN_ACT",
      "harness workflow complete --phase $DYN_PHASE",
    ]) {
      expect(isWorkerRecursiveWorkflowCommand(cmd), cmd).toBe(true)
      expect(classifyCommand(cmd, { unitWorkerMode: true }), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd, { unitWorkerMode: true })?.ruleId, cmd).toBe(
        "worker-recursive-workflow-command",
      )
    }

    for (const credCmd of [
      "SOCK=.git/harness/daemon.sock; cat $SOCK",
      "TOK=auth-tokens.json; head ${TOK}",
      "DIR=.harness/omnigraph-cluster; ls $DIR/auth-tokens.json",
      'CMD="cat .git/harness/daemon.sock"; eval "$CMD"',
    ]) {
      expect(isWorkerDaemonCredentialShellAccess(credCmd), credCmd).toBe(true)
      expect(classifyCommand(credCmd, { unitWorkerMode: true }), credCmd).toBe("deny")
      expect(explainCommandDenyRule(credCmd, { unitWorkerMode: true })?.ruleId, credCmd).toBe(
        "worker-daemon-credential-access",
      )
    }

    expect(isWorkerRecursiveWorkflowCommand('eval "echo ok"')).toBe(false)
    expect(isWorkerRecursiveWorkflowCommand("CMD='harness done'; rg -n '$CMD' libs/")).toBe(false)
  })

  it("F-3.5 / F-23.5 fails closed when subshell nesting exceeds MAX_SUBSHELL_INSPECT_DEPTH = 4 while allowing depth <= 4 benign commands", () => {
    expect(MAX_SUBSHELL_INSPECT_DEPTH).toBe(4)
    const depth5Cmd = "echo $(echo $(echo $(echo $(echo $(echo ok)))))"
    expect(isWorkerRecursiveWorkflowCommand(depth5Cmd)).toBe(true)
    expect(isWorkerDaemonCredentialShellAccess(depth5Cmd)).toBe(true)
    expect(classifyCommand(depth5Cmd, { unitWorkerMode: true })).toBe("deny")

    const depth4Benign = "echo $(echo $(echo $(echo ok)))"
    expect(isWorkerRecursiveWorkflowCommand(depth4Benign)).toBe(false)
    expect(isWorkerDaemonCredentialShellAccess(depth4Benign)).toBe(false)
    expect(classifyCommand(depth4Benign, { unitWorkerMode: true })).toBe("escalate")
  })

  it("REQ-4.6 / F-3.4 keeps workflow complete --phase unit, workflow status, verify, and non-worker mode allowed", () => {
    const nonRecursiveAllowed: ReadonlyArray<{
      readonly cmd: string
      readonly expectedVerdict: "allow" | "escalate"
    }> = [
      { cmd: "harness workflow complete --run-id r1 --unit u1", expectedVerdict: "escalate" },
      {
        cmd: "pnpm harness workflow complete --run-id r1 --unit u1 --phase unit",
        expectedVerdict: "allow",
      },
      {
        cmd: "nx run harness-cli:start -- workflow complete --run-id r1 --unit u1",
        expectedVerdict: "allow",
      },
      { cmd: "pnpm harness workflow status --run-id r1 --json", expectedVerdict: "allow" },
      { cmd: "harness workflow status", expectedVerdict: "escalate" },
      {
        cmd: "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts workflow complete --run-id r1",
        expectedVerdict: "allow",
      },
      {
        cmd: "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts workflow status",
        expectedVerdict: "allow",
      },
      { cmd: "harness workflow --run-id start status", expectedVerdict: "escalate" },
      { cmd: "harness workflow complete --unit start --phase done", expectedVerdict: "escalate" },
      { cmd: "pnpm harness verify", expectedVerdict: "allow" },
      { cmd: "nx run @harness/gates:verify", expectedVerdict: "allow" },
      { cmd: "pnpm --filter @harness/gates run test", expectedVerdict: "allow" },
      {
        cmd: "pnpm --filter harness-cli start workflow complete --run-id r1",
        expectedVerdict: "allow",
      },
      { cmd: "pnpm --filter harness-cli start workflow status", expectedVerdict: "allow" },
      { cmd: "pnpm --filter harness-cli test", expectedVerdict: "allow" },
      { cmd: "deno eval \"console.log('harness done')\"", expectedVerdict: "escalate" },
    ]
    expect(isWorkerRecursiveWorkflowCommand("")).toBe(false)
    expect(isWorkerRecursiveWorkflowCommand("   ")).toBe(false)
    for (const entry of nonRecursiveAllowed) {
      expect(isWorkerRecursiveWorkflowCommand(entry.cmd), entry.cmd).toBe(false)
      expect(classifyCommand(entry.cmd, { unitWorkerMode: true }), entry.cmd).toBe(
        entry.expectedVerdict,
      )
    }
    expect(isWorkerRecursiveWorkflowCommand("node -e \"console.log('harness done')\"")).toBe(false)
    expect(isWorkerRecursiveWorkflowCommand('git commit -m "chore: harness done"')).toBe(false)
    expect(isWorkerRecursiveWorkflowCommand('rg "harness workflow start" libs/')).toBe(false)
    expect(isWorkerRecursiveWorkflowCommand("rg -n 'hello $(harness done)' libs/")).toBe(false)
    expect(isWorkerRecursiveWorkflowCommand("git commit -m '$(harness done)'")).toBe(false)
    expect(classifyCommand("pnpm harness workflow start", { unitWorkerMode: false })).toBe("allow")
    expect(classifyCommand("pnpm harness done")).toBe("allow")
  })

  it("REQ-4.6 blocks daemon socket and auth-tokens shell/file access under HARNESS_UNIT_WORKER=1", () => {
    expect(classifyWorkerFileAccessFromFastpath("auth-tokens.json", true).verdict).toBe("deny")
    expect(classifyWorkerFileAccessFromIndex("daemon.sock", true).verdict).toBe("deny")

    const daemonCredentialDenied: ReadonlyArray<string> = [
      "cat .git/harness/auth-tokens.json",
      "head -n 5 .harness/omnigraph-cluster/auth-tokens.json",
      "tail -f /tmp/common-dir/harness/daemon.sock",
      "grep token auth-tokens.json",
      "rg -n foo .git/harness/daemon.sock",
      "rg -f auth-tokens.json libs/",
      "jq . .harness/omnigraph-cluster/auth-tokens.json",
      "ls -la .git/harness/daemon.sock",
      "stat /tmp/common-dir/harness/daemon.sock",
      "strings .git/harness/auth-tokens.json",
      "base64 auth-tokens.json",
      "curl --unix-socket /tmp/common-dir/harness/daemon.sock http://localhost/status",
      "nc -U .git/harness/daemon.sock",
      "socat - UNIX-CONNECT:.git/harness/daemon.sock",
      "python3 -c 'open(\".harness/omnigraph-cluster/auth-tokens.json\").read()'",
      'node -e \'require("fs").readFileSync("auth-tokens.json")\'',
      'sh -c "cat .git/harness/daemon.sock"',
      "cat <.git/harness/auth-tokens.json",
      "echo hi > .git/harness/daemon.sock",
      "HARNESS_SOCK=/tmp/common-dir/harness/daemon.sock env",
      "pnpm --dir .git/harness exec ls daemon.sock",
      "cat .git/harness/sub/../auth-tokens.json",
      "cat '.git\\harness\\daemon.sock'",
      "echo $(cat .git/harness/auth-tokens.json)",
      "cat .harness/omnigraph-cluster/auth-tokens.*",
      "rg -u . .harness/omnigraph-cluster",
      "head .harness/omnigraph-cluster/*",
      "Read .harness/omnigraph-cluster",
      "cat .git/harness/daemon.soc*",
      "cat .git/harness/daemon.soc[k]",
      "cat .git/harness/auth-tokens*",
      "cat <(cat .harness/omnigraph-cluster/auth-tokens.json)",
      "bash -c -l 'cat .harness/omnigraph-cluster/*'",
    ]
    for (const cmd of daemonCredentialDenied) {
      expect(isWorkerDaemonCredentialShellAccess(cmd), cmd).toBe(true)
      expect(classifyCommand(cmd, { unitWorkerMode: true }), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd, { unitWorkerMode: true })?.ruleId, cmd).toBe(
        "worker-daemon-credential-access",
      )
    }

    expect(classifyCommand("ls -la .git/harness/daemon.sock")).toBe("allow")
    expect(isWorkerDaemonCredentialShellAccess("")).toBe(false)
    expect(isWorkerDaemonCredentialShellAccess('rg -n "daemon.sock" libs/')).toBe(false)
    expect(isWorkerDaemonCredentialShellAccess('git commit -m "guard daemon.sock"')).toBe(false)
    expect(isWorkerDaemonCredentialShellAccess("cat daemon.sock.md")).toBe(false)
    expect(classifyCommand("ls -la libs/harness/gates/src", { unitWorkerMode: true })).toBe("allow")

    expect(classifyWorkerFileAccess("auth-tokens.json").verdict).toBe("allow")
    expect(classifyWorkerFileAccess("auth-tokens.json", false).verdict).toBe("allow")
    expect(classifyWorkerFileAccess("   ", true).verdict).toBe("allow")
    expect(classifyWorkerFileAccess("libs/harness/gates/src/policy.ts", true).verdict).toBe("allow")
    expect(classifyWorkerFileAccess(".harness/omnigraph-cluster/auth-tokens.json", true)).toEqual(
      expect.objectContaining({ verdict: "deny", ruleId: "worker-daemon-credential-access" }),
    )
    expect(classifyWorkerFileAccess("/tmp/common-dir/harness/daemon.sock", true)).toEqual(
      expect.objectContaining({ verdict: "deny", ruleId: "worker-daemon-credential-access" }),
    )
    expect(classifyWorkerFileAccess("C:\\repo\\.git\\harness\\daemon.sock", true).verdict).toBe(
      "deny",
    )
    expect(classifyWorkerFileAccess(".git/harness/sub/../auth-tokens.json", true).verdict).toBe(
      "deny",
    )
    expect(classifyWorkerFileAccess(".harness/omnigraph-cluster", true)).toEqual(
      expect.objectContaining({ verdict: "deny", ruleId: "worker-daemon-credential-access" }),
    )
    expect(classifyWorkerFileAccess(".harness/omnigraph-cluster/*", true).verdict).toBe("deny")
    expect(classifyWorkerFileAccess(".harness/omnigraph-cluster", false).verdict).toBe("allow")
    expect(classifyWorkerFileAccess(".git/harness/auth-tokens.*", true).verdict).toBe("deny")
    expect(classifyWorkerFileAccess(".git/harness/daemon.soc*", true).verdict).toBe("deny")

    expect(classifyFileWrite("auth-tokens.json").ruleId).toBe("harness-common-dir-state")
    expect(classifyFileWrite("auth-tokens.json", { unitWorkerMode: true }).ruleId).toBe(
      "worker-daemon-credential-access",
    )
    expect(classifyFileWrite(".git/harness/daemon.sock", { unitWorkerMode: true }).ruleId).toBe(
      "worker-daemon-credential-access",
    )
    expect(
      classifyFileWrite("libs/order/domain/src/order.ts", { unitWorkerMode: true }).verdict,
    ).toBe("allow")
  })

  it("blocks nx run-many/affected, pnpm --filter globs, glob obfuscations, and shell .harness inspection under HARNESS_UNIT_WORKER=1", () => {
    const recursiveDenied: ReadonlyArray<string> = [
      "nx run-many -t start -- workflow start --plan plan.json",
      "pnpm nx run-many --targets=start,lint -p harness-cli -- workflow abort --run-id r1",
      'nx run-many -t start -p "harness-*" -- workflow start',
      'nx run-many -t start -p "tag:type:app" -- done',
      "nx affected -t start -- workflow abort --run-id r1",
      "nx run-many -tstart -pharness-cli -- workflow start",
      "nx --exclude foo run harness-cli:start -- workflow abort --run-id r1",
      'pnpm --filter "harness-*" start workflow start',
      'pnpm --filter "./apps/*" start done',
      'pnpm --filter "!@harness/gates" start workflow abort --run-id r1',
      'pnpm --filter "harness-*" run start workflow start',
    ]
    for (const cmd of recursiveDenied) {
      expect(isWorkerRecursiveWorkflowCommand(cmd), cmd).toBe(true)
      expect(classifyCommand(cmd, { unitWorkerMode: true }), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd, { unitWorkerMode: true })?.ruleId, cmd).toBe(
        "worker-recursive-workflow-command",
      )
    }

    for (const allowedCmd of [
      "nx affected -t verify",
      'pnpm --filter "harness-*" run test',
      "nx run-many -t start -p unrelated-pkg -- workflow start",
    ]) {
      expect(isWorkerRecursiveWorkflowCommand(allowedCmd), allowedCmd).toBe(false)
      expect(classifyCommand(allowedCmd, { unitWorkerMode: true }), allowedCmd).toBe("allow")
    }

    for (const credCmd of [
      "rg -uu . .harness",
      "grep -rn . .harness/",
      "cat .harness/omnigraph*/*",
      "head .harness/*/auth*",
    ]) {
      expect(isWorkerDaemonCredentialShellAccess(credCmd), credCmd).toBe(true)
      expect(classifyCommand(credCmd, { unitWorkerMode: true }), credCmd).toBe("deny")
      expect(explainCommandDenyRule(credCmd, { unitWorkerMode: true })?.ruleId, credCmd).toBe(
        "worker-daemon-credential-access",
      )
    }
    expect(
      classifyCommand("cat .harness/workflow-worktrees/run-1/u-1/src/a.ts", {
        unitWorkerMode: true,
      }),
    ).toBe("allow")

    for (const obfuscatedSecret of ["**/.[e]nv*", "**/{.env,.dev.vars}"]) {
      expect(
        classifyFileRead(obfuscatedSecret, { unitWorkerMode: true }),
        obfuscatedSecret,
      ).toEqual(expect.objectContaining({ verdict: "deny", ruleId: "secret-file" }))
    }
    for (const obfuscatedCred of [
      "**/auth*tokens*",
      "**/daemon.sock*",
      "**/*omnigraph-cluster*",
      ".harness/[o]mnigraph-cluster/auth-tokens.json",
    ]) {
      expect(classifyFileRead(obfuscatedCred, { unitWorkerMode: true }), obfuscatedCred).toEqual(
        expect.objectContaining({ verdict: "deny", ruleId: "worker-daemon-credential-access" }),
      )
    }
  })

  it("SPEC-0030 2nd-pass: denies piped xargs inspect, wrapper -C .git, and .git/h* / .harness/o* globs while allowing workflow worktrees", () => {
    for (const credCmd of [
      "pnpm -C .git exec ls",
      "env -C .git ls",
      "echo .git | xargs ls",
      "printf '%s\\n' .git/h* | xargs env cat",
      "echo .harness/o* | xargs -I{} sh -c 'cat {}'",
    ]) {
      expect(isWorkerDaemonCredentialShellAccess(credCmd), credCmd).toBe(true)
      expect(classifyCommand(credCmd, { unitWorkerMode: true }), credCmd).toBe("deny")
      expect(explainCommandDenyRule(credCmd, { unitWorkerMode: true })?.ruleId, credCmd).toBe(
        "worker-daemon-credential-access",
      )
    }

    for (const globPath of [".git/h*", ".harness/o*"]) {
      expect(classifyFileRead(globPath, { unitWorkerMode: true }), globPath).toEqual(
        expect.objectContaining({ verdict: "deny", ruleId: "worker-daemon-credential-access" }),
      )
      expect(classifyFileWrite(globPath, { unitWorkerMode: true }), globPath).toEqual(
        expect.objectContaining({ verdict: "deny", ruleId: "worker-daemon-credential-access" }),
      )
    }

    const worktreeFile = ".harness/workflow-worktrees/run-1/u1/src/foo.ts"
    expect(classifyFileRead(worktreeFile, { unitWorkerMode: true }).verdict).toBe("allow")
    expect(classifyFileWrite(worktreeFile, { unitWorkerMode: true }).verdict).toBe("allow")
    expect(isWorkerDaemonCredentialShellAccess(`echo ${worktreeFile} | xargs ls`)).toBe(false)
    expect(classifyCommand(`echo ${worktreeFile} | xargs ls`, { unitWorkerMode: true })).not.toBe(
      "deny",
    )
    expect(classifyCommand(`cat ${worktreeFile}`, { unitWorkerMode: true })).toBe("allow")
  })
})
