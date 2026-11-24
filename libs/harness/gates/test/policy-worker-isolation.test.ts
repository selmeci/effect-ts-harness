import { describe, expect, it } from "vitest"
import { unwrapCommandSegment } from "../src/policy-shell-parser.js"
import { stripSafeLeadingEnvVarsDetailed } from "../src/policy-command-rules.js"
import { isWorkerRecursiveWorkflowCommand } from "../src/policy-worker-isolation.js"
import {
  classifyCommand,
  classifyFileRead,
  classifyFileWrite,
  explainCommandDenyReason,
  explainCommandDenyRule,
  SKIP_NX_CACHE_BANNED_REASON,
  isCommandAllowed,
  isSkipNxCacheCommand,
} from "../src/policy.js"

describe("guard policy wrapper isolation, glob hardening & worktree mode", () => {
  it("F-7.4/F-18.1 unwraps process wrappers and bun package-runner commands cleanly without regressing bun script/eval forms", () => {
    // F-7.4: process wrapper unwrapping for deny, skip-nx-cache, ask, and exempted read-only escalate
    for (const denied of [
      { cmd: "timeout 5 rm .git/harness/daemon.lock", ruleId: "harness-state-mutation" },
      { cmd: "timeout -k 5 10 rm .git/harness/daemon.lock", ruleId: "harness-state-mutation" },
      {
        cmd: "timeout --signal=TERM 10s grep foo .git/harness/daemon.lock",
        ruleId: "harness-state-mutation",
      },
      { cmd: "timeout 10 grep foo .git/harness/auth-tokens.json", ruleId: "secret-file-access" },
      { cmd: "nice -n 10 rm .git/harness/daemon.lock", ruleId: "harness-state-mutation" },
      {
        cmd: "nice --adjustment=5 grep foo .git/harness/daemon.lock",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "nohup python3 -c \"open('.git/harness/auth-tokens.json','w')\"",
        ruleId: "harness-state-mutation",
      },
      { cmd: "stdbuf -o0 -e0 rm .git/harness/daemon.lock", ruleId: "harness-state-mutation" },
      {
        cmd: "stdbuf -o 0 -e L grep foo .git/harness/daemon.lock",
        ruleId: "harness-state-mutation",
      },
      { cmd: "time -p rm .git/harness/daemon.lock", ruleId: "harness-state-mutation" },
      { cmd: "time -o .git/harness/daemon.lock ls", ruleId: "harness-state-mutation" },
      { cmd: "timeout 10 nx test @harness/gates --skip-nx-cache", ruleId: "skip-nx-cache-banned" },
      {
        cmd: "nice -n 10 nx run @harness/gates:verify --skip-nx-cache",
        ruleId: "skip-nx-cache-banned",
      },
      { cmd: "time -p pnpm nx test --skip-nx-cache", ruleId: "skip-nx-cache-banned" },
      {
        cmd: "stdbuf -o0 -e0 bun nx affected -t verify --skip-nx-cache",
        ruleId: "skip-nx-cache-banned",
      },
    ] as const) {
      expect(classifyCommand(denied.cmd), denied.cmd).toBe("deny")
      expect(explainCommandDenyRule(denied.cmd)?.ruleId, denied.cmd).toBe(denied.ruleId)
    }

    expect(classifyCommand("timeout 5 git reset --hard HEAD~1")).toBe("ask")
    expect(
      classifyCommand("HARNESS_ALLOW_SKIP_NX_CACHE=1 timeout 10 nx test --skip-nx-cache"),
    ).toBe("ask")
    expect(classifyCommand("timeout 5 ls .git/harness")).toBe("escalate")
    expect(classifyCommand("nice -n 10 find .git/harness -maxdepth 2")).toBe("escalate")
    expect(classifyCommand("nohup python3 script.py")).toBe("escalate")

    expect(
      unwrapCommandSegment(["timeout", "-k", "5", "10", "rm", ".git/harness/daemon.lock"]),
    ).toEqual({
      envAssignments: [],
      commandWords: ["rm", ".git/harness/daemon.lock"],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["nice", "-n", "10", "grep", "foo", "bar"])).toEqual({
      envAssignments: [],
      commandWords: ["grep", "foo", "bar"],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["stdbuf", "-o0", "-e0", "cat", "foo"])).toEqual({
      envAssignments: [],
      commandWords: ["cat", "foo"],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["time", "-p", "nx", "test"])).toEqual({
      envAssignments: [],
      commandWords: ["nx", "test"],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["nohup", "python3", "script.py"])).toEqual({
      envAssignments: [],
      commandWords: ["python3", "script.py"],
      sawPackageRunner: false,
    })

    // F-18.1: bun package-runner unwrapping vs script/eval non-runner preservation
    for (const bunSkipCmd of [
      "bun nx affected -t verify --skip-nx-cache",
      "bun nx run @harness/gates:verify --skip-nx-cache",
      "bun --bun nx affected -t verify --skip-nx-cache",
      "bun --cwd apps/cli nx test --skip-nx-cache",
      "bun --preload ./setup.ts nx test --skip-nx-cache",
      "bun verify --skip-nx-cache",
    ]) {
      expect(isSkipNxCacheCommand(bunSkipCmd), bunSkipCmd).toBe(true)
      expect(classifyCommand(bunSkipCmd), bunSkipCmd).toBe("deny")
      expect(explainCommandDenyRule(bunSkipCmd)?.ruleId, bunSkipCmd).toBe("skip-nx-cache-banned")
      expect(explainCommandDenyReason(bunSkipCmd), bunSkipCmd).toBe(SKIP_NX_CACHE_BANNED_REASON)
    }

    expect(
      classifyCommand(
        "HARNESS_ALLOW_SKIP_NX_CACHE=1 bun nx run @harness/gates:verify --skip-nx-cache",
      ),
    ).toBe("ask")

    expect(
      unwrapCommandSegment(["bun", "nx", "affected", "-t", "verify", "--skip-nx-cache"]),
    ).toEqual({
      envAssignments: [],
      commandWords: ["nx", "affected", "-t", "verify", "--skip-nx-cache"],
      sawPackageRunner: true,
    })

    for (const nonRunnerWords of [
      ["bun", "script.js"],
      ["bun", "path/to/file.ts"],
      ["bun", "-e", "console.log(1)"],
      ["bun", "--eval", "console.log(1)"],
      ["bun", "-p", "1+1"],
      ["bun", "--version"],
      ["bun", "--", "run"],
      ["bun", "test"],
    ]) {
      expect(unwrapCommandSegment(nonRunnerWords).sawPackageRunner, nonRunnerWords.join(" ")).toBe(
        false,
      )
    }
  })

  it("closes P0/P1/P2 rg and git grep -f/-e/--files/--regexp secret and harness-state bypasses", () => {
    const deniedCases: ReadonlyArray<{ readonly cmd: string; readonly ruleId: string }> = [
      {
        cmd: "rg -f tsconfig.json .git/harness/auth-tokens.json",
        ruleId: "secret-file-access",
      },
      {
        cmd: "rg -f tsconfig.json .git/harness/server.json",
        ruleId: "harness-state-mutation",
      },
      { cmd: "rg --file=tsconfig.json .env", ruleId: "secret-file-access" },
      { cmd: "rg -ftsconfig.json .env", ruleId: "secret-file-access" },
      { cmd: "rg -f.env libs/", ruleId: "secret-file-access" },
      { cmd: "rg --files .git/harness/auth-tokens.json", ruleId: "secret-file-access" },
      { cmd: "rg --files .git/harness/daemon.lock.meta.json", ruleId: "harness-state-mutation" },
      { cmd: "rg --regexp=foo .env", ruleId: "secret-file-access" },
      {
        cmd: "git grep -e. --no-index .git/harness/auth-tokens.json",
        ruleId: "secret-file-access",
      },
      {
        cmd: "git grep -e. --no-index .git/harness/server.json",
        ruleId: "harness-state-mutation",
      },
      { cmd: "git grep --regexp=. --no-index .env", ruleId: "secret-file-access" },
      { cmd: "git grep --regexp . --no-index .env", ruleId: "secret-file-access" },
      {
        cmd: "git grep -f .git/harness/auth-tokens.json --no-index libs/",
        ruleId: "secret-file-access",
      },
      {
        cmd: "git grep -f .git/harness/server.json --no-index libs/",
        ruleId: "harness-state-mutation",
      },
      { cmd: "git grep --file=.env --no-index libs/", ruleId: "secret-file-access" },
      { cmd: "git grep -f.env --no-index libs/", ruleId: "secret-file-access" },
    ]
    for (const c of deniedCases) {
      expect(classifyCommand(c.cmd), c.cmd).toBe("deny")
      expect(explainCommandDenyRule(c.cmd)?.ruleId, c.cmd).toBe(c.ruleId)
    }
  })

  it("closes P0/P1/P2 wrapper -C/--dir/--cwd, env -S/-u, time -o, GIT_COMMON_DIR, command -pv cd, and harness --cwd guard bypasses", () => {
    const deniedCases: ReadonlyArray<{ readonly cmd: string; readonly ruleId: string }> = [
      {
        cmd: "pnpm --filter . -C .git/harness/workflow-backups exec rm workflow-backup-123.ndjson",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "pnpm --filter . --dir .git/harness/omnigraph exec truncate -s 0 server.json",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "pnpm --filter . --dir=.git/harness/workflow-backups exec rm snap.ndjson",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "pnpm --filter . -C .git/harness exec cat daemon.lock.meta.json",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "pnpm --filter . -C .git exec rm harness/daemon.lock.meta.json",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "env -C .git/harness/workflow-backups rm snap.ndjson",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "env --chdir=.git/harness/workflow-backups rm snap.ndjson",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "env -C.git/harness/workflow-backups rm snap.ndjson",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "bun --cwd .git/harness rm -f daemon.lock.meta.json",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "bun --cwd=.git/harness rm -f daemon.lock.meta.json",
        ruleId: "harness-state-mutation",
      },
      { cmd: 'env -S "ls; rm .git/harness/daemon.lock"', ruleId: "harness-state-mutation" },
      {
        cmd: 'env -S "pnpm harness status; chmod 777 .git/harness/auth-tokens.json"',
        ruleId: "harness-state-mutation",
      },
      {
        cmd: 'env -S "pnpm harness status; chmod 777 .git/harness/daemon.lock"',
        ruleId: "harness-state-mutation",
      },
      { cmd: "env -uFOO cd /tmp", ruleId: "cd-command-banned" },
      { cmd: "command -pv cd /tmp", ruleId: "cd-command-banned" },
      { cmd: 'pnpm harness --cwd /tmp guard "rm -r dist"', ruleId: "guard-self-invocation" },
      { cmd: 'pnpm harness --cwd /tmp -- guard "rm -r dist"', ruleId: "guard-self-invocation" },
      {
        cmd: 'rm "$(git rev-parse --git-common-dir)//harness/custom.json"',
        ruleId: "harness-state-mutation",
      },
      {
        cmd: 'COMMON=$(git rev-parse --git-common-dir); rm "${COMMON%/}/harness/custom.json"',
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "export GIT_COMMON_DIR=/tmp/meta; rm /tmp/meta/harness/custom.json",
        ruleId: "harness-state-mutation",
      },
      { cmd: "time --output=.git/harness/custom.log ls", ruleId: "harness-state-mutation" },
      { cmd: "time -o.git/harness/custom.log ls", ruleId: "harness-state-mutation" },
    ]
    for (const c of deniedCases) {
      expect(classifyCommand(c.cmd), c.cmd).toBe("deny")
      expect(explainCommandDenyRule(c.cmd)?.ruleId, c.cmd).toBe(c.ruleId)
    }
    expect(
      classifyCommand("node ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard"),
    ).toBe("deny")
    expect(
      explainCommandDenyRule(
        "node ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard",
      )?.ruleId,
    ).toBe("guard-self-invocation")
  })

  it("denies git upload-pack/receive-pack/exec and ext:: transfer overrides", () => {
    for (const cmd of [
      "git ls-remote --upl=touch .",
      "git ls-remote --upload=touch .",
      "git ls-remote --upload-pac touch .",
      "git ls-remote -ubash .",
      "git ls-remote -u'touch f' .",
      "git ls-remote --upload-pack=bash .",
      "git ls-remote --upload-pack='sh -c id' .",
      "git ls-remote -u bash .",
      "git fetch --upl=bash",
      "git clone -u bash repo",
      "git push --rece=bash origin main",
      "git archive --exec=bash HEAD",
      "git ls-remote 'ext::sh -c id'",
      'git fetch origin "a\nb" --upload-pack=bash',
      'git push origin "a\nb" --exec=bash',
      'git push origin "a\nb" --receive-pack=bash',
      'git fetch origin "a\nb" "ext::sh -c id"',
    ]) {
      expect(classifyCommand(cmd), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd)?.ruleId, cmd).toBe("git-pack-exec-override")
    }
  })

  it("allows safe rg/git/pnpm/env prefixes and rejects unsafe env prefixes and overlong inputs", () => {
    for (const allowedCmd of [
      "rg --files libs/",
      "rg -f tsconfig.json libs/",
      "git grep '\\.env' -- libs",
      "git ls-files",
      "git ls-files libs/harness/gates",
      "git push -u origin feat",
      "git fetch -u",
      "git fetch --update-head-ok",
      "git fetch --unshallow",
      "git push --recurse-submodules=check",
      "pnpm --filter @harness/gates -C libs/harness/gates exec vitest",
      "TMPDIR=/home/roan/.cache/tmp NX_SOCKET_DIR=/home/roan/.cache/tmp/nx NODE_COMPILE_CACHE=/home/roan/.cache/node NX_DAEMON=false FORCE_COLOR=0 NO_COLOR=1 CI=true pnpm nx run @harness/gates:test",
      "NX_DAEMON=true FORCE_COLOR=3 NO_COLOR=0 pnpm nx test",
      "HARNESS_REQUIRE_OLLAMA=1 pnpm test",
      "HARNESS_WORKTREE_ID=unit-a pnpm nx run @harness/gates:verify",
    ]) {
      expect(classifyCommand(allowedCmd), allowedCmd).toBe("allow")
    }

    expect(classifyCommand("git ls-remote origin main")).toBe("escalate")
    expect(classifyCommand("git ls-files-evil")).toBe("escalate")
    expect(classifyCommand("git ls-remote-evil")).toBe("escalate")
    expect(classifyCommand("git ls-remote origin main ; rm -rf /")).toBe("deny")
    expect(
      classifyCommand(
        "TMPDIR=/home/roan/.cache/tmp git status && TMPDIR=/home/roan/.cache/tmp git push origin main",
      ),
    ).toBe("escalate")

    for (const nonAllowedEnvCmd of [
      "TMPDIR=/tmp/../etc pnpm nx test",
      "TMPDIR=relative/path pnpm nx test",
      "NX_SOCKET_DIR=nx/sock pnpm nx test",
      "TMPDIR=/tmp/$(whoami) pnpm nx test",
      'TMPDIR="/tmp/ok" pnpm nx test',
      "TMPDIR='/tmp/ok' pnpm nx test",
      "NODE_OPTIONS=--inspect pnpm nx test",
      "GIT_COMMON_DIR=/tmp/g pnpm nx test",
      "GIT_DIR=/tmp/g pnpm nx test",
      "HARNESS_STATE_DIR=/tmp/h pnpm nx test",
      "HARNESS_SUBAGENT=1 pnpm harness done",
      "HARNESS_WORKTREE_ID=fake pnpm harness done",
      "HARNESS_WORKTREE_ID=unit-a pnpm harness done",
      "HARNESS_GIT_BRANCH=main pnpm harness done",
      "CI=${HARNESS_STATE_DIR:=/tmp/evil} pnpm test",
      "CI=yes pnpm nx test",
      "NX_INTERACTIVE=maybe pnpm nx test",
      "HARNESS_PLAN_CHECK=2 pnpm nx test",
      "HARNESS_REQUIRE_OLLAMA=true pnpm nx test",
      "HARNESS_LOG_LEVEL=verbose pnpm nx test",
      "HARNESS_WORKTREE_ID=../bad pnpm nx test",
      "HARNESS_WORKTREE_ID=a/b pnpm nx test",
      "HARNESS_WORKTREE_ID=.hidden pnpm nx test",
      "TMPDIR=/repo/.git/hooks pnpm test",
      "NODE_COMPILE_CACHE=/repo/repos/effect pnpm test",
      "TMPDIR=/tmp/.harness pnpm nx test",
      "TMPDIR=/tmp/.env pnpm nx test",
      "TMPDIR=/tmp/.git/harness pnpm nx test",
      "TMPDIR=/tmp/secret pnpm nx test",
      "TMPDIR=/tmp/ok ",
      "NX_DAEMON=maybe pnpm nx test",
      "FORCE_COLOR=9 pnpm nx test",
      "NO_COLOR=2 pnpm nx test",
    ]) {
      expect(isCommandAllowed(nonAllowedEnvCmd), nonAllowedEnvCmd).toBe(false)
      expect(classifyCommand(nonAllowedEnvCmd), nonAllowedEnvCmd).not.toBe("allow")
    }

    const longStart = performance.now()
    expect(classifyCommand("CI=1 ".repeat(50_000) + "curl x")).toBe("ask")
    expect(performance.now() - longStart).toBeLessThan(200)
    expect(classifyCommand("CI=1 ".repeat(33) + "pnpm test")).toBe("escalate")
    expect(classifyCommand("NX_SKIP_NX_CACHE=1 pnpm nx test")).toBe("deny")
    expect(classifyCommand("TMPDIR=/home/roan/.cache/tmp rm -rf /")).toBe("deny")
  })

  it("harness:SPEC-0024 strips validated env -u / --unset wrappers and allows read-only df, git worktree list, and wc/rg filters", () => {
    expect(
      stripSafeLeadingEnvVarsDetailed("env -u HARNESS_WORKTREE_ID pnpm harness verify"),
    ).toEqual({ rest: "pnpm harness verify", sawWorktreeId: false })
    expect(
      stripSafeLeadingEnvVarsDetailed("CI=true env -u HARNESS_WORKTREE_ID -u NX_DAEMON pnpm test"),
    ).toEqual({ rest: "pnpm test", sawWorktreeId: false })
    expect(stripSafeLeadingEnvVarsDetailed("env --unset=HARNESS_WORKTREE_ID pnpm test")).toEqual({
      rest: "pnpm test",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env CI=true pnpm test")).toEqual({
      rest: "pnpm test",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env HARNESS_WORKTREE_ID=wt1 pnpm test")).toEqual({
      rest: "pnpm test",
      sawWorktreeId: true,
    })
    expect(
      stripSafeLeadingEnvVarsDetailed(
        "HARNESS_WORKTREE_ID=wt1 env -u HARNESS_WORKTREE_ID pnpm harness verify",
      ),
    ).toEqual({ rest: "pnpm harness verify", sawWorktreeId: true })
    expect(stripSafeLeadingEnvVarsDetailed("env -u HARNESS_WORKTREE_ID")).toEqual({
      rest: "",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env pnpm test")).toEqual({
      rest: "env pnpm test",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env -u PATH pnpm test")).toEqual({
      rest: "env -u PATH pnpm test",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env --unset=PATH pnpm test")).toEqual({
      rest: "env --unset=PATH pnpm test",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env -i pnpm test")).toEqual({
      rest: "env -i pnpm test",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env PATH=/tmp pnpm test")).toEqual({
      rest: "env PATH=/tmp pnpm test",
      sawWorktreeId: false,
    })
    expect(stripSafeLeadingEnvVarsDetailed("env -u")).toEqual({
      rest: "env -u",
      sawWorktreeId: false,
    })

    for (const allowedCmd of [
      "env -u HARNESS_WORKTREE_ID pnpm harness verify",
      "env -u HARNESS_WORKTREE_ID CI=true pnpm harness verify && env -u HARNESS_WORKTREE_ID CI=true pnpm harness done",
      "env -u HARNESS_WORKTREE_ID -u NX_DAEMON pnpm test",
      "env --unset=HARNESS_WORKTREE_ID pnpm --filter @harness/gates run test",
      "df -ih /tmp",
      "df",
      "git worktree list",
      "git worktree list --porcelain",
      "git status | rg policy | wc",
      "ls -la libs/harness | rg -n telemetry",
    ]) {
      expect(classifyCommand(allowedCmd), allowedCmd).toBe("allow")
    }

    for (const nonAllowed of [
      { cmd: "env -u PATH pnpm test", verdict: "escalate" },
      { cmd: "env --unset=PATH pnpm test", verdict: "escalate" },
      { cmd: "env -i pnpm test", verdict: "escalate" },
      { cmd: "env pnpm test", verdict: "escalate" },
      { cmd: "env -u HARNESS_WORKTREE_ID", verdict: "escalate" },
      { cmd: "env HARNESS_WORKTREE_ID=wt1 pnpm harness verify", verdict: "escalate" },
      {
        cmd: "HARNESS_WORKTREE_ID=wt1 env -u HARNESS_WORKTREE_ID pnpm harness verify",
        verdict: "escalate",
      },
      { cmd: "env -u HARNESS_WORKTREE_ID git push --force", verdict: "deny" },
      { cmd: "git worktree remove /tmp/wt-1", verdict: "escalate" },
      { cmd: "dfx build", verdict: "escalate" },
      { cmd: "pnpm --filter @harness/gates exec rm a.ts", verdict: "escalate" },
      { cmd: "pnpm --filter @harness/gates dlx foo", verdict: "escalate" },
      { cmd: "nx exec -- echo hi", verdict: "escalate" },
      { cmd: "rg --pre sh daemon libs/", verdict: "escalate" },
      { cmd: "rg --pre sh daemon .harness/verify-stamp.json", verdict: "deny" },
      { cmd: "sort -o .harness/verify-stamp.json a.txt", verdict: "deny" },
      { cmd: "git diff --output .harness/verify-stamp.json", verdict: "deny" },
      { cmd: "find libs -fprint .harness/verify-stamp.json", verdict: "deny" },
    ] as const) {
      expect(classifyCommand(nonAllowed.cmd), nonAllowed.cmd).toBe(nonAllowed.verdict)
    }

    for (const safeCmd of [
      "pnpm --filter @harness/gates exec vitest run test/policy.test.ts",
      "CI=true pnpm --filter @harness/gates exec nx show projects",
      "cat .oxlintrc.json",
      "rg pattern tools/oxlint",
    ]) {
      expect(classifyCommand(safeCmd), safeCmd).toBe("allow")
    }
  })

  it("SPEC-0030 2nd-pass: closes ANSI-C alignment/NUL, flagged pnpm/nx, bundled filter flags, multiline args, empty-prefix braces, unset var fallback, xargs env, and glob brackets", () => {
    for (const deniedCmd of [
      "echo $'\\x41\\x42\\x43\\x44'; rm .harness/verify-stamp.json",
      "echo $'\\x41'; cd /tmp",
      "echo $'a\\'b' .e\\\nnv",
      "echo $'a\\'b' $(rm .env)",
      "A=.env; echo $'a\\'b' $A",
      "cat $'.env\\x00ignored'",
      "cat ${UNSET:-.env}",
      "echo .harness/verify-stamp.json | xargs env rm",
    ]) {
      expect(classifyCommand(deniedCmd), deniedCmd).toBe("deny")
    }

    for (const escalatedCmd of [
      "pnpm --filter @harness/gates --silent exec sh",
      "pnpm --filter @harness/gates --silent dlx evil-pkg",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter @harness/gates --silent harness done",
      "nx --verbose exec -- cat /etc/passwd",
      "sort -uo out.txt",
      "ls | sort -uo out.txt",
      'ls | sort "-o" out.txt',
      "ls | rg '--pre' evil",
      'git diff "foo\nbar" --output=/tmp/out',
      'find . -name "a\nb" -delete',
      'sort "a\nb" -o out.txt',
      'rg "a\nb" --pre sh foo',
      "cat .{,e}nv",
    ]) {
      expect(classifyCommand(escalatedCmd), escalatedCmd).toBe("escalate")
    }

    expect(
      isCommandAllowed("HARNESS_WORKTREE_ID=u1 pnpm --filter @harness/gates --silent harness done"),
    ).toBe(false)

    for (const allowedCmd of [
      "pnpm --filter @harness/gates --silent exec -- vitest run",
      "git status | rg policy | wc",
      "git status | grep foo | wc",
    ]) {
      expect(classifyCommand(allowedCmd), allowedCmd).toBe("allow")
    }

    for (const secretPath of [
      ".env?",
      ".dev.vars?",
      ".e[mn][uv]",
      ".[abcde]nv",
      ".[a-z]nv",
      ".[!x]nv",
      "*.k[d-f]y",
      "auth-tok[d-f]ns.json",
    ]) {
      expect(classifyFileRead(secretPath).verdict, `read ${secretPath}`).toBe("deny")
      expect(classifyFileWrite(secretPath).verdict, `write ${secretPath}`).toBe("deny")
    }
    expect(classifyFileWrite(".harness/veri[fghij]y-stamp.json").verdict).toBe("deny")

    for (const routePath of [
      "apps/web/routes/[accountId]/page.tsx",
      "apps/web/routes/[...catchall].tsx",
    ]) {
      expect(classifyFileRead(routePath).verdict, `read ${routePath}`).toBe("allow")
      expect(classifyFileWrite(routePath).verdict, `write ${routePath}`).toBe("allow")
    }
  })

  it("F-3.1: blocks all harness-cli and start invocations under HARNESS_WORKTREE_ID across nx and pnpm forms while allowing scoped package verify", () => {
    for (const blockedCmd of [
      "HARNESS_WORKTREE_ID=u1 nx harness-cli:start -- done",
      "HARNESS_WORKTREE_ID=u1 nx start harness-cli",
      "HARNESS_WORKTREE_ID=u1 nx start",
      "HARNESS_WORKTREE_ID=u1 nx run-many -t start -p harness-cli",
      "HARNESS_WORKTREE_ID=u1 nx run-many -t start",
      "HARNESS_WORKTREE_ID=u1 nx affected --target=start",
      "HARNESS_WORKTREE_ID=u1 nx run-many --targets=build,start",
      "HARNESS_WORKTREE_ID=u1 nx run-many -t verify -p @harness/gates,harness-cli",
      "HARNESS_WORKTREE_ID=u1 pnpm nx harness-cli:start -- done",
      "HARNESS_WORKTREE_ID=u1 pnpm nx start harness-cli",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter harness-cli start",
      "HARNESS_WORKTREE_ID=u1 pnpm -F harness-cli run verify",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter @harness/gates start",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter @harness/gates run start",
      "HARNESS_WORKTREE_ID=u1 pnpm exec nx run harness-cli:start",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter @harness/gates exec nx run harness-cli:start",
      "pnpm exec HARNESS_WORKTREE_ID=u1 nx run harness-cli:start",
      "HARNESS_WORKTREE_ID=u1 node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts done",
    ]) {
      expect(isCommandAllowed(blockedCmd), blockedCmd).toBe(false)
      expect(classifyCommand(blockedCmd), blockedCmd).not.toBe("allow")
    }

    for (const allowedCmd of [
      "HARNESS_WORKTREE_ID=u1 pnpm nx run @harness/gates:verify",
      "HARNESS_WORKTREE_ID=u1 nx test @harness/gates",
      "HARNESS_WORKTREE_ID=u1 nx run-many -t verify -p @harness/gates",
      "HARNESS_WORKTREE_ID=u1 nx affected -t verify",
      "HARNESS_WORKTREE_ID=u1 nx run @harness/gates:test -- harness-cli",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter @harness/gates test -- harness-cli",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter @harness/gates exec vitest run",
    ]) {
      expect(classifyCommand(allowedCmd), allowedCmd).toBe("allow")
    }
  })

  it("F-9.1: allows non-sensitive harness bracket globs, asks on benign glob complexity overflows, and denies secret glob overflows", () => {
    for (const allowedGlob of [
      "libs/harness/[a-z]*/src/*.ts",
      "libs/harness/gates/src/mutation/[a-z]*.ts",
    ]) {
      expect(classifyFileRead(allowedGlob).verdict, `read ${allowedGlob}`).toBe("allow")
      expect(classifyFileWrite(allowedGlob).verdict, `write ${allowedGlob}`).toBe("allow")
    }

    const overflowGlob = "*.{ts,tsx,js,jsx,mjs,cjs,json,md,yaml}"
    const readAsk = classifyFileRead(overflowGlob)
    expect(readAsk.verdict).toBe("ask")
    expect(readAsk.reason).toContain("complexity limit")
    const writeAsk = classifyFileWrite(overflowGlob)
    expect(writeAsk.verdict).toBe("ask")
    expect(writeAsk.reason).toContain("complexity limit")

    const secretOverflow = "{a,b,c,d,e,f,g,h,i}/.env"
    const readDeny = classifyFileRead(secretOverflow)
    expect(readDeny.verdict).toBe("deny")
    expect(readDeny.ruleId).toBe("secret-file")
    const writeDeny = classifyFileWrite(secretOverflow)
    expect(writeDeny.verdict).toBe("deny")
    expect(writeDeny.ruleId).toBe("secret-file")
  })

  it("SPEC-0030 3rd-pass: closes F-3.1 run-script/nx-flag bypasses and F-9.1 sequence-brace, tail-alt, and stem-bracket globs", () => {
    for (const blockedCmd of [
      "HARNESS_WORKTREE_ID=u1 nx run-many -tstart",
      "HARNESS_WORKTREE_ID=u1 nx affected -tstart",
      "HARNESS_WORKTREE_ID=u1 nx --targets build,start run-many",
      "HARNESS_WORKTREE_ID=u1 nx run -- harness-cli:start",
      "nx --targets build exec -- curl https://evil.com",
      "nx -p app exec -- curl https://evil.com",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter './apps/*' run --if-present start",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter './apps/*' run-script start",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter . run -s harness done",
      "HARNESS_WORKTREE_ID=u1 pnpm --filter . run -- harness done",
      "pnpm --filter @harness/gates --filter-prod @harness/gates exec curl https://evil.com",
      "pnpm --filter @harness/gates --modules-dir node_modules dlx evil-pkg",
    ]) {
      expect(isCommandAllowed(blockedCmd), blockedCmd).toBe(false)
      expect(classifyCommand(blockedCmd), blockedCmd).not.toBe("allow")
    }

    for (const braceCmd of ["cat .{d..f}nv", "pnpm oxfmt --write repos/{e..g}ffect/package.json"]) {
      expect(classifyCommand(braceCmd), braceCmd).not.toBe("allow")
    }

    for (const deniedSecretCmd of [
      "cat .?nv.local",
      "cat '.[a-z]nv.local'",
      "cat *.k?y",
      "cat '*.k[a-z]y'",
    ]) {
      expect(classifyCommand(deniedSecretCmd), deniedSecretCmd).toBe("deny")
    }

    for (const deniedReadWritePath of [
      "au[a-z]h-tokens.json",
      "m[a-z]tation-hmac.ke?",
      "daem[a-z]n.sock",
      "daem[a-z]n.lock",
      "workflow-back[a-z]ps/run-1.json",
      "common-d[a-z]r/harness/state.json",
      "pending-workflow-rest[a-z]re.json",
      "[.-]e[a-z]v",
      "[.a-z]d?v.vars",
      "*.k?y",
      "*.k[a-z]y",
      ".{d..f}nv",
      "{a,b,c,d,e,f,g,h,.env}",
    ]) {
      expect(classifyFileRead(deniedReadWritePath).verdict, `read ${deniedReadWritePath}`).toBe(
        "deny",
      )
      expect(classifyFileWrite(deniedReadWritePath).verdict, `write ${deniedReadWritePath}`).toBe(
        "deny",
      )
    }

    for (const deniedWriteSubtree of [
      "rep[a-z]s/effect/package.json",
      "re[k-p][m-r]s/effect/package.json",
      "repos/{e..g}ffect/package.json",
    ]) {
      expect(classifyFileWrite(deniedWriteSubtree).verdict, `write ${deniedWriteSubtree}`).toBe(
        "deny",
      )
    }

    for (const governancePath of [
      "tools/oxl[a-z]nt/syntax-bans.js",
      "tools/ox[g-l][d-i]nt/syntax-bans.js",
    ]) {
      expect(classifyFileWrite(governancePath).verdict, `write ${governancePath}`).toBe("ask")
      expect(classifyFileRead(governancePath).verdict, `read ${governancePath}`).toBe("allow")
    }

    for (const workerCredPath of ["au[a-z]h-tokens.json", "daem[a-z]n.sock", "daem[a-z]n.lock"]) {
      const workerRead = classifyFileRead(workerCredPath, { unitWorkerMode: true })
      expect(workerRead.verdict, workerCredPath).toBe("deny")
      expect(workerRead.ruleId, workerCredPath).toBe("worker-daemon-credential-access")
    }

    expect(classifyFileRead("*.json").verdict).toBe("allow")
    expect(classifyFileWrite("*.json").verdict).toBe("allow")
  })

  it("closes quoted-glob secret/state bypasses, pnpm --shell-mode, nx -- positional tasks, and >64-alt brace tails (F-9.1, F-3.1)", () => {
    const quotedSecretGlobCmds: ReadonlyArray<string> = [
      "rg --no-ignore --hidden -g '{.env,foo}' . .",
      "rg --no-ignore --hidden -g '.e[a-z]v' . .",
      "find . -name '.e[a-z]v'",
      "rg --no-ignore --hidden -g '.en[a-z]' . .",
      "find . -name '.dev.[a-z]ars'",
      "rg --no-ignore --hidden -g '*.[a-z]ey' . .",
      "find . -name '*.[a-z]ey'",
      "rg --no-ignore --hidden -g '*.p*m' . .",
      "find . -name '*.p*m'",
      "rg --no-ignore --hidden -g 'mutation-hma[a-z].ke[x-z]' . .",
      "rg --no-ignore --hidden --iglob '*.P*M' . .",
      "cat '.[e]nv'",
    ]
    for (const cmd of quotedSecretGlobCmds) {
      expect(classifyCommand(cmd), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd)?.ruleId, cmd).toBe("secret-file-access")
    }

    expect(classifyCommand("find . -name 'daem[a-z]n.sock'")).toBe("deny")
    expect(explainCommandDenyRule("find . -name 'daem[a-z]n.sock'")?.ruleId).toBe(
      "harness-state-mutation",
    )

    for (const allowedGlobCmd of [
      "rg --no-ignore --hidden -g '*.ts' foo .",
      "find . -name '*.{ts,tsx}'",
      "rg -g '*.json' foo .",
    ]) {
      expect(classifyCommand(allowedGlobCmd), allowedGlobCmd).toBe("allow")
    }

    expect(classifyCommand("pnpm --filter . --shell-mode exec -- bash -c id")).not.toBe("allow")
    expect(classifyCommand("pnpm --filter . --shell-mode dlx evil-pkg")).not.toBe("allow")
    expect(
      classifyCommand("HARNESS_WORKTREE_ID=u1 pnpm --filter . run --shell-mode harness done"),
    ).toBe("escalate")
    expect(classifyCommand("HARNESS_WORKTREE_ID=u1 nx run -c prod -- harness-cli:start")).toBe(
      "escalate",
    )
    expect(classifyCommand("HARNESS_WORKTREE_ID=u1 nx -- harness-cli:start")).toBe("escalate")
    expect(
      classifyCommand("HARNESS_WORKTREE_ID=u1 nx run @harness/gates:test -- harness-cli"),
    ).toBe("allow")
    expect(
      classifyCommand("HARNESS_WORKTREE_ID=u1 nx run -c prod @harness/gates:test -- harness-cli"),
    ).toBe("allow")

    expect(classifyFileWrite("{a,b,c,d,e,f,g,h,repos}/{e,f}ffect/package.json")).toEqual({
      verdict: "deny",
      ruleId: "readonly-subtree",
      reason: expect.stringContaining("{a,b,c"),
    })
    const alts64 = Array.from({ length: 64 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`).join(
      ",",
    )
    const brace65Secret = `{${alts64},.env}`
    expect(classifyFileWrite(brace65Secret).verdict).toBe("deny")
    expect(classifyFileWrite(brace65Secret).ruleId).toBe("secret-file")
    expect(classifyFileRead(brace65Secret).verdict).toBe("deny")
    expect(classifyFileRead(brace65Secret).ruleId).toBe("secret-file")
  })

  it("blocks workflow ship and --run variants under HARNESS_UNIT_WORKER=1 across direct and wrapped forms", () => {
    for (const blockedCmd of [
      "pnpm harness workflow ship",
      "pnpm harness workflow ship --run my-run-id-1",
      "pnpm harness workflow --run my-run-id-1 ship",
      "pnpm harness workflow --run-id my-run-id-1 ship",
      "harness workflow ship",
      "harness --repo-root /tmp workflow ship --run my-run-id-1",
      "timeout 5 pnpm harness workflow ship --run my-run-id-1",
      "env -u NX_DAEMON pnpm --filter harness-cli start -- workflow ship --run my-run-id-1",
      'sh -c "pnpm harness workflow ship --run my-run-id-1"',
      "pnpm --filter . run -- harness workflow ship --run my-run-id-1",
      "node apps/harness-cli/src/index.ts workflow ship --run my-run-id-1",
      "pnpm --filter . --workspace-concurrency 1 harness workflow ship",
      "pnpm --filter . --lockfile-dir . harness done --cli",
      "pnpm --filter . --filter-prod harness-cli start -- workflow ship",
      "pnpm --filter . --filter-prod=harness-cli run start -- workflow ship",
      "pnpm --filter harness-cli run start -- workflow ship",
      "pnpm --filter harness-cli run-script start -- workflow ship",
      "env --chdir=apps/harness-cli pnpm start -- done",
      'env "--split-string=pnpm harness done"',
      "command env --chdir=apps/harness-cli pnpm start -- done",
      'command env --split-string="pnpm harness done"',
      "echo done | xargs env --chdir=apps/harness-cli pnpm start --",
      'echo x | xargs env "--split-string=pnpm harness done"',
      "pnpm --filter . --modules-dir nm --virtual-store-dir vs --globalconfig gc --script-shell /bin/sh harness workflow ship",
      "pnpm --filter . --test-pattern '*.ts' --changed-files-ignore-pattern '*.md' harness workflow ship",
      "pnpm harness workflow --log-level info ship --run r1",
      "pnpm harness workflow --json false ship --run r1",
      "pnpm harness workflow --rebuild-views true ship --run r1",
      "pnpm harness workflow --json 0 ship --run r1",
      "pnpm harness workflow --json yes abort --run r1",
      "pnpm harness --log-level info done --cli",
      "pnpm harness --cli true done",
      "pnpm harness workflow --log-level info complete --unit u1 --phase llm",
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts workflow --log-level info ship",
      "node --experimental-specifier-resolution node apps/harness-cli/src/index.ts workflow ship",
      "node --disable-proto throw apps/harness-cli/src/index.ts workflow --json false ship",
    ]) {
      expect(isWorkerRecursiveWorkflowCommand(blockedCmd), blockedCmd).toBe(true)
      expect(classifyCommand(blockedCmd, { unitWorkerMode: true }), blockedCmd).toBe("deny")
      expect(explainCommandDenyRule(blockedCmd, { unitWorkerMode: true })?.ruleId, blockedCmd).toBe(
        "worker-recursive-workflow-command",
      )
    }

    for (const allowedWorkerCmd of [
      "pnpm harness gc --strict",
      "pnpm harness workflow status",
      "pnpm harness workflow status --run my-run-id-1",
      "pnpm harness workflow --json false status",
      "pnpm harness workflow --log-level info status",
      "pnpm harness workflow complete --unit u1 --phase unit",
      "pnpm --filter @harness/gates run test",
    ]) {
      expect(isWorkerRecursiveWorkflowCommand(allowedWorkerCmd), allowedWorkerCmd).toBe(false)
      expect(classifyCommand(allowedWorkerCmd, { unitWorkerMode: true }), allowedWorkerCmd).toBe(
        "allow",
      )
    }

    for (const nonRecursiveCmd of [
      "pnpm --filter",
      "pnpm -C",
      "env --chdir=libs/foo pnpm test",
      'env "--split-string=pnpm test"',
    ]) {
      expect(isWorkerRecursiveWorkflowCommand(nonRecursiveCmd), nonRecursiveCmd).toBe(false)
    }
  })
})
