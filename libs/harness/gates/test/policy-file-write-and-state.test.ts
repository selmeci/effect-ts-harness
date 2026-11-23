import { describe, expect, it } from "vitest"
import {
  extractCommandSegments,
  normalizeShellLineContinuations,
  unwrapCommandSegment,
} from "../src/policy-shell-parser.js"
import {
  classifyCommand,
  classifyFileWrite,
  explainCommandDenyReason,
  explainCommandDenyRule,
  SKIP_NX_CACHE_BANNED_REASON,
  isCommandAllowed,
  isHarnessStateMutationCommand,
  isSkipNxCacheCommand,
  isSkipNxCacheOverrideCommand,
  toCommandView,
  type CommandDenyRuleId,
  type FileWriteDenyRuleId,
} from "../src/policy.js"

describe("guard policy file writes, shell normalization & harness state protection", () => {
  it("denies --skip-nx-cache and --skipNxCache on nx and verify commands while allowing =false and grep/rg", () => {
    expect(isSkipNxCacheCommand("nx test @harness/gates --skip-nx-cache")).toBe(true)
    expect(classifyCommand("nx test @harness/gates --skip-nx-cache")).toBe("deny")
    expect(classifyCommand("pnpm nx run gates:verify --skip-nx-cache")).toBe("deny")
    expect(classifyCommand("CI=true npx nx affected --skip-nx-cache")).toBe("deny")
    expect(classifyCommand("CI=true pnpm nx test --skip-nx-cache=true")).toBe("deny")
    expect(classifyCommand("./node_modules/.bin/nx test --skip-nx-cache")).toBe("deny")
    expect(classifyCommand("pnpm verify -- --skip-nx-cache")).toBe("deny")
    expect(isSkipNxCacheCommand("pnpm verify:all -- --skip-nx-cache")).toBe(true)

    expect(isSkipNxCacheCommand("nx test @harness/gates --skipNxCache")).toBe(true)
    expect(classifyCommand("nx test @harness/gates --skipNxCache")).toBe("deny")
    expect(classifyCommand("pnpm nx run gates:verify --skipNxCache=true")).toBe("deny")
    expect(isSkipNxCacheCommand("nx test @harness/gates --skipNxCache=false")).toBe(false)
    expect(classifyCommand("nx test @harness/gates --skipNxCache=false")).toBe("allow")

    expect(isSkipNxCacheCommand("nx test @harness/gates --skip-nx-cache=false")).toBe(false)
    expect(classifyCommand("nx test @harness/gates --skip-nx-cache=false")).toBe("allow")

    expect(isSkipNxCacheCommand("grep skip-nx-cache libs/")).toBe(false)
    expect(classifyCommand("grep skip-nx-cache libs/")).toBe("allow")
    expect(isSkipNxCacheCommand("rg --skip-nx-cache libs/")).toBe(false)
    expect(classifyCommand("rg --skip-nx-cache libs/")).toBe("allow")
    expect(isSkipNxCacheCommand("pnpm vitest run --skip-nx-cache")).toBe(false)
    expect(SKIP_NX_CACHE_BANNED_REASON).not.toContain("HARNESS_ALLOW_SKIP_NX_CACHE")
  })

  it("denies NX_SKIP_NX_CACHE and NX_DISABLE_NX_CACHE env assignments across inline, env, and wrapped runners", () => {
    expect(isSkipNxCacheCommand("NX_SKIP_NX_CACHE=true pnpm nx test @harness/gates")).toBe(true)
    expect(classifyCommand("NX_SKIP_NX_CACHE=1 pnpm test")).toBe("deny")
    expect(classifyCommand("NX_DISABLE_NX_CACHE=true pnpm nx run gates:verify")).toBe("deny")
    expect(classifyCommand("env NX_DISABLE_NX_CACHE=1 nx test")).toBe("deny")
    expect(classifyCommand("pnpm exec NX_SKIP_NX_CACHE=true nx test")).toBe("deny")
    expect(isSkipNxCacheCommand("NX_SKIP_NX_CACHE=false pnpm nx test")).toBe(false)
    expect(isSkipNxCacheCommand("NX_DISABLE_NX_CACHE=0 nx test")).toBe(false)
  })

  it("requires human confirmation ('ask') for HARNESS_ALLOW_SKIP_NX_CACHE=1 on skip-nx-cache commands and never auto-allows it on non-skip commands", () => {
    expect(
      isSkipNxCacheCommand(
        "HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx run @harness/gates:test --skip-nx-cache",
      ),
    ).toBe(false)
    expect(
      isSkipNxCacheOverrideCommand(
        "HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx run @harness/gates:test --skip-nx-cache",
      ),
    ).toBe(true)
    expect(
      classifyCommand(
        "HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx run @harness/gates:test --skip-nx-cache",
      ),
    ).toBe("ask")
    expect(classifyCommand("HARNESS_ALLOW_SKIP_NX_CACHE=1 NX_SKIP_NX_CACHE=1 pnpm nx test")).toBe(
      "ask",
    )

    expect(isSkipNxCacheOverrideCommand("HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx test")).toBe(false)
    expect(isCommandAllowed("HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx test")).toBe(false)
    expect(classifyCommand("HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx test")).toBe("escalate")
  })

  it("denies --skip-nx-cache across pipes, compound operators, env wrappers, and subshell grouping", () => {
    expect(classifyCommand("nx test --skip-nx-cache | tail -20")).toBe("deny")
    expect(classifyCommand("echo ok && nx test --skip-nx-cache")).toBe("deny")
    expect(classifyCommand('"foo"&&nx test --skip-nx-cache')).toBe("deny")
    expect(classifyCommand("true;pnpm nx test --skip-nx-cache")).toBe("deny")
    expect(classifyCommand("/usr/bin/env -i pnpm nx test --skip-nx-cache")).toBe("deny")
    expect(classifyCommand("pnpm --loglevel warn nx run @harness/gates:test --skip-nx-cache")).toBe(
      "deny",
    )
    expect(classifyCommand("echo ok&nx test --skip-nx-cache")).toBe("deny")
    expect(toCommandView("echo foo&>bar").argv).toBe("echo foo&>bar")
    expect(isSkipNxCacheCommand("env -i FOO=1 nx test --skip-nx-cache")).toBe(true)
    expect(isSkipNxCacheCommand("env -- nx test --skip-nx-cache")).toBe(true)
    expect(isSkipNxCacheCommand("")).toBe(false)
    expect(isSkipNxCacheCommand("FOO=1")).toBe(false)
  })

  // S-7.2a — HARNESS_TEST_ISOLATION / HARNESS_DISABLE_LIVE_TELEMETRY prefix stripping
  it("does not strip HARNESS_TEST_ISOLATION or HARNESS_DISABLE_LIVE_TELEMETRY into auto-allow while stripping benign HARNESS_* vars", () => {
    expect(isCommandAllowed("HARNESS_TEST_ISOLATION=1 pnpm nx run @harness/gates:test")).toBe(false)
    expect(classifyCommand("HARNESS_TEST_ISOLATION=1 pnpm nx run @harness/gates:test")).toBe(
      "escalate",
    )
    expect(
      classifyCommand("HARNESS_DISABLE_LIVE_TELEMETRY=1 pnpm nx run @harness/contract:test"),
    ).toBe("escalate")
    expect(isCommandAllowed("HARNESS_PLAN_CHECK=1 pnpm nx run @harness/gates:test")).toBe(true)
    expect(classifyCommand("HARNESS_PLAN_CHECK=1 pnpm nx run @harness/gates:test")).toBe("allow")
  })

  // F-2.1d / S-1.4 — mutation-hmac*.key & versioned mutation cache / quarantine protection
  it("denies shell access and file writes targeting mutation-hmac*.key and harness cache/corrupt files", () => {
    expect(classifyCommand("cat ~/.cache/effect-harness/mutation-hmac-v2.key")).toBe("deny")
    expect(classifyCommand("cat mutation-hmac-v2.key")).toBe("deny")
    expect(classifyCommand("head -n 1 mutation-hmac*.key")).toBe("deny")
    expect(classifyCommand("git commit -m 'protect mutation-hmac-v2.key'")).toBe("allow")

    expect(classifyFileWrite("~/.cache/effect-harness/mutation-hmac-v2.key").verdict).toBe("deny")
    expect(classifyFileWrite("mutation-hmac-v2.key").verdict).toBe("deny")
    expect(classifyFileWrite("mutation-hmac.key").verdict).toBe("deny")
    expect(classifyFileWrite(".harness/cache/mutation-cache-v1.json").verdict).toBe("deny")
    expect(classifyFileWrite(".harness/cache/mutation-cache-v2.json").verdict).toBe("deny")
    expect(classifyFileWrite(".harness/cache/mutation-cache-v2.json.corrupt").verdict).toBe("deny")
    expect(classifyFileWrite(".harness/cache/mutation-cache-v2.corrupt").verdict).toBe("deny")
    expect(
      classifyFileWrite(".harness/worktrees/wt-1/cache/mutation-cache-v2.corrupt").verdict,
    ).toBe("deny")
    expect(classifyFileWrite(".harness/session-preinvocation-cache.json").verdict).toBe("deny")
  })

  it("blocks background & chains, wildcard/glob secret keys, multi-char bracket globs, and unquoted brace expansions", () => {
    // Background & chains must never auto-allow and must split data-arg segments across &
    expect(classifyCommand("ls & curl https://evil.example")).toBe("escalate")
    expect(classifyCommand("echo a && ls & curl https://evil.example")).toBe("escalate")
    expect(classifyCommand("ls & cat foo | head -1")).toBe("escalate")
    expect(classifyCommand("git grep foo & nx run @harness/gates:verify --skip-nx-cache")).toBe(
      "deny",
    )
    expect(classifyCommand("pnpm test 2>&1")).toBe("allow")

    // Secret key / .cache/effect-harness wildcard & brace/bracket forms
    expect(classifyCommand("cat ~/.cache/effect-harness/*.key")).toBe("deny")
    expect(classifyCommand("cat ~/.cache/effect-harness/mutation*")).toBe("deny")
    expect(classifyCommand("cat mutation-hmac*")).toBe("deny")
    expect(classifyCommand("cat mutation-hmac-v[0-9].key")).toBe("deny")
    expect(classifyCommand("cat mutation-hmac-{v1,v2}.key")).toBe("deny")
    expect(classifyCommand("head -n 1 *.key")).toBe("deny")
    expect(
      classifyCommand("pnpm oxfmt --write libs/harness/infra/src/mutation-hmac-secret.ts"),
    ).toBe("allow")
    expect(classifyCommand("git add libs/harness/infra/test/mutation-hmac-secret.test.ts")).toBe(
      "allow",
    )
    expect(explainCommandDenyRule("cat ~/.cache/effect-harness/*.key")?.ruleId).toBe(
      "secret-file-access",
    )
    expect(explainCommandDenyRule("cat mutation-hmac-{v1,v2}.key")?.ruleId).toBe(
      "secret-file-access",
    )

    // Plugin dir & quoted commit messages stay allowed
    expect(classifyCommand("ls adapters/antigravity/plugins/effect-harness")).toBe("allow")
    expect(classifyCommand("git commit -m 'fix {a,b} and mutation-hmac-v2.key'")).toBe("allow")

    // Unquoted brace expansion & multi-char bracket class escalate
    expect(classifyCommand("cat foo.{ts,js}")).toBe("escalate")
    expect(classifyCommand("cat file[0-9].txt")).toBe("escalate")
    expect(classifyCommand("r[m] -rf /tmp/x")).toBe("escalate")
  })

  // S-7.3 — explainCommandDenyRule / explainCommandDenyReason coverage
  it("explains every command deny ruleId and returns undefined for non-denied commands", () => {
    const cases: ReadonlyArray<{ readonly cmd: string; readonly ruleId: CommandDenyRuleId }> = [
      { cmd: "cd libs/harness", ruleId: "cd-command-banned" },
      { cmd: "nx show projects", ruleId: "interactive-nx-banned" },
      { cmd: "pnpm nx test --skip-nx-cache", ruleId: "skip-nx-cache-banned" },
      { cmd: "ollama run clef-flash", ruleId: "invalid-clef-endpoint" },
      { cmd: "rm -rf /tmp/foo", ruleId: "denylist-token" },
      { cmd: "git push origin main --force", ruleId: "git-force-push" },
      { cmd: "rm .git/harness/daemon.lock", ruleId: "harness-state-mutation" },
      { cmd: "cat .env", ruleId: "secret-file-access" },
      { cmd: "cat ~/.cache/effect-harness/mutation-hmac-v2.key", ruleId: "secret-file-access" },
      { cmd: "cat .git/harness/auth-tokens.json", ruleId: "secret-file-access" },
      { cmd: 'pnpm harness guard "ls"', ruleId: "guard-self-invocation" },
    ]
    for (const c of cases) {
      const explained = explainCommandDenyRule(c.cmd)
      expect(explained?.ruleId, c.cmd).toBe(c.ruleId)
      expect(explained?.reason.length, c.cmd).toBeGreaterThan(0)
      expect(explainCommandDenyReason(c.cmd), c.cmd).toBe(explained?.reason)
    }

    for (const nonDenied of [
      "",
      "pnpm test",
      "curl https://example.com",
      "alchemy deploy",
      "HARNESS_ALLOW_SKIP_NX_CACHE=1 pnpm nx test --skip-nx-cache",
    ]) {
      expect(explainCommandDenyRule(nonDenied), nonDenied).toBeUndefined()
      expect(explainCommandDenyReason(nonDenied), nonDenied).toBeUndefined()
    }
  })

  it("normalizes shell escapes, trailing backslashes, and git/gh data arguments in toCommandView", () => {
    // Double-quoted vs single-quoted backslash handling and trailing-backslash bounds
    expect(toCommandView('echo "a\\"b"').argv).toBe('echo a"b')
    expect(toCommandView("echo 'a\\' b").argv).toBe("echo a\\ b")
    expect(toCommandView('echo "abc\\').argv).toBe("echo abc\\")
    expect(toCommandView("echo abc\\").argv).toBe("echo abc\\")
    expect(toCommandView("echo a\\ b").argv).toBe("echo a b")
    expect(classifyCommand('git commit -m "say \\" protect .env \\""')).toBe("allow")

    // git commit -m / --message / --amend / -m... / --message=...
    expect(toCommandView("git commit -m .env src/a.ts").argv).toBe("git commit src/a.ts")
    expect(toCommandView("git commit --message .env src/a.ts").argv).toBe("git commit src/a.ts")
    expect(toCommandView("git commit --amend .env").argv).toBe("git commit --amend .env")
    expect(toCommandView("git commit -m.env --message=.env src/a.ts").argv).toBe(
      "git commit src/a.ts",
    )
    expect(toCommandView("git status --message=.env").argv).toBe("git status --message=.env")

    // git log --grep / --grep=...
    expect(toCommandView("git log --grep .env --oneline .env2").argv).toBe(
      "git log --oneline .env2",
    )
    expect(toCommandView("git status --grep .env").argv).toBe("git status --grep .env")
    expect(toCommandView("git log --grep=.env src/a.ts").argv).toBe("git log src/a.ts")
    expect(toCommandView("git status --grep=.env").argv).toBe("git status --grep=.env")

    // gh pr -t / --title / -b / --body
    expect(
      toCommandView("gh pr create -t .env1 --title .env2 -b .env3 --body .env4 --draft .env5").argv,
    ).toBe("gh pr create --draft .env5")
    expect(toCommandView("gh pr edit -t .env src/a.ts").argv).toBe("gh pr edit src/a.ts")
    expect(toCommandView("gh pr edit --title .env src/a.ts").argv).toBe("gh pr edit src/a.ts")
    expect(toCommandView("gh pr edit -b .env src/a.ts").argv).toBe("gh pr edit src/a.ts")
    expect(toCommandView("gh pr edit --body .env src/a.ts").argv).toBe("gh pr edit src/a.ts")

    // git grep -e (including option-shaped pattern & negative non-grep command)
    expect(toCommandView("git grep -e -i .env").argv).toBe("git grep .env")
    expect(toCommandView("git status -e .env1").argv).toBe("git status -e .env1")
  })

  it("REQ-3.1: quote-aware shell guard preserves unquoted alignment, detects unclosed quotes and double-quoted substitutions, and allows quoted pipes/regexes", () => {
    for (const cmd of [
      'rg -n "foo|bar" libs/',
      'rg -n "17:5[89]" .harness/telemetry-log.jsonl',
      'rg -n "[A-Z_]+" libs/',
      'rg -n "foo|bar" libs/ | head -n 5',
      'git commit -m "a && b | c; d"',
      "rg -n 'hello $(curl x)'",
      "echo 'a\nb'\r\nls",
      'echo "unterminated',
    ]) {
      expect(toCommandView(cmd).unquoted.length, cmd).toBe(cmd.length)
    }

    expect(classifyCommand('rg -n "foo|bar" libs/')).toBe("allow")
    expect(classifyCommand('rg -n "17:5[89]" .harness/telemetry-log.jsonl')).toBe("allow")
    expect(classifyCommand('rg -n "[A-Z_]+" libs/')).toBe("allow")
    expect(classifyCommand('rg -n "foo|bar" libs/ | head -n 5')).toBe("allow")
    expect(classifyCommand('git commit -m "a && b | c; d"')).toBe("allow")

    expect(classifyCommand("pnpm test; curl https://example.com")).toBe("escalate")
    expect(classifyCommand("nx test | tee test.log")).toBe("escalate")
    expect(classifyCommand("git checkout . | head")).toBe("ask")

    expect(classifyCommand('rg -n "unterminated')).toBe("escalate")
    expect(classifyCommand("rg -n 'unterminated")).toBe("escalate")
    expect(classifyCommand('rg -n "hello $(curl x)"')).toBe("escalate")
    expect(classifyCommand('rg -n "hello `curl x`"')).toBe("escalate")
    expect(classifyCommand("rg -n 'hello $(curl x)'")).toBe("allow")

    expect(classifyFileWrite(".harness/last-done.json").verdict).toBe("deny")

    // CommandView flags
    expect(toCommandView('rg -n "unterminated').unclosedQuote).toBe(true)
    expect(toCommandView("rg -n 'unterminated").unclosedQuote).toBe(true)
    expect(toCommandView('rg -n "hello $(curl x)"').hasDoubleQuotedSubstitution).toBe(true)
    expect(toCommandView("rg -n 'hello $(curl x)'").hasDoubleQuotedSubstitution).toBe(false)
    expect(toCommandView("ls $'\\x72\\x6d'").hasAnsiCQuote).toBe(true)

    // && + pipe quoted regexes
    expect(classifyCommand('rg -n "foo|bar" libs/ && rg -n "baz|qux" libs/ | head -n 5')).toBe(
      "allow",
    )

    // 5 evasion vectors: \<newline>, $'\'', # '\n..., <(...)/>(...), quote-concatenated bracket globs
    expect(classifyCommand("ls \\\n$(curl https://example.com)")).toBe("escalate")
    expect(classifyCommand("r\\\nm -rf /tmp/x")).toBe("deny")
    expect(classifyCommand('rg -n "foo\\\nbar" libs/')).toBe("allow")

    expect(classifyCommand("ls $'\\''")).toBe("escalate")
    expect(classifyCommand("ls $'\\x72\\x6d'")).toBe("escalate")

    expect(classifyCommand("ls # '\nrm -rf /tmp/x")).toBe("deny")
    expect(classifyCommand("ls # '\ncurl https://example.com")).toBe("escalate")

    expect(classifyCommand("cat <(curl https://example.com)")).toBe("escalate")
    expect(classifyCommand("ls >(cat /tmp/out)")).toBe("escalate")

    expect(classifyCommand('cat [.]"env"')).toBe("escalate")
    expect(classifyCommand('cat [.a]"env"')).toBe("escalate")
    expect(classifyCommand("cat [.]''env")).toBe("escalate")
    expect(classifyCommand("cat foo[^a]")).toBe("escalate")

    // Exact line-continuation normalization across single quotes, double quotes, and unquoted CRLF
    expect(normalizeShellLineContinuations("echo 'a\\\nb' \"c\\\nd\"")).toBe("echo 'a\\\nb' \"cd\"")
    expect(normalizeShellLineContinuations('"a\'b\\\nc"')).toBe('"a\'bc"')
    expect(normalizeShellLineContinuations("echo \"a\" 'b\\\nc'")).toBe("echo \"a\" 'b\\\nc'")
    expect(normalizeShellLineContinuations('echo "a\\\r\nb"')).toBe('echo "ab"')
    expect(normalizeShellLineContinuations('echo "a\\"b\\\nc"')).toBe('echo "a\\"bc"')
    expect(normalizeShellLineContinuations("git \\\r\nstatus")).toBe("git status")

    // ANSI-C quotes & multi-line comment boundaries
    const ansiView = toCommandView("$'foo\\'bar' && git status")
    expect(ansiView.unclosedQuote).toBe(false)
    expect(ansiView.hasAnsiCQuote).toBe(true)
    expect(ansiView.argv).toBe("foo'bar && git status")
    const ansiTrunc = toCommandView("$'abc\\")
    expect(ansiTrunc.unclosedQuote).toBe(true)
    expect(ansiTrunc.argv).toBe("abc\\")
    expect(toCommandView("git status # rm -rf /\ngit diff").argv).toBe("git status git diff")
    expect(classifyCommand("git status # rm -rf /\ngit diff")).toBe("escalate")
  })

  it("REQ-4.6 denies file writes to <git-common-dir>/harness/** and protected runtime state files while allowing workflow source files", () => {
    const deniedPaths = [
      ".git/harness",
      ".git/harness/custom.json",
      "/path/to/repo/.git/harness/auth-tokens.json",
      "/path/to/repo/.git/harness/daemon.sock",
      "/path/to/repo/.git/harness/daemon.lock",
      "/path/to/repo/.git/harness/workflow-backups/2026-11-19.ndjson",
      "/path/to/bare.git/harness/state.json",
      "/path/to/repo/.git/worktrees/wt-1/../../harness/daemon.lock",
      ".git/worktrees/wt-1/../../harness/auth-tokens.json",
      ".git\\harness\\daemon.sock",
      "auth-tokens.json",
      ".harness/omnigraph-cluster/auth-tokens.json",
      "daemon.sock",
      ".harness/daemon.sock",
      "daemon.lock",
      "/custom/common-dir/harness/workflow-backups/snap.ndjson",
      "workflow-backups/2026-11-19.ndjson",
    ]
    for (const p of deniedPaths) {
      const res = classifyFileWrite(p)
      expect(res.verdict, p).toBe("deny")
      expect(res.ruleId, p).toBe("harness-common-dir-state")
    }

    const ruleCases: ReadonlyArray<{
      readonly path: string
      readonly ruleId: FileWriteDenyRuleId
    }> = [
      { path: "repos/effect/LLMS.md", ruleId: "readonly-subtree" },
      { path: ".harness/verify-stamp.json", ruleId: "verify-stamp" },
      { path: ".harness/mutate-stamp.json", ruleId: "mutate-stamp" },
      { path: ".harness/last-done.json", ruleId: "harness-cache" },
      { path: ".harness/graph-snapshot.json", ruleId: "harness-cache" },
      { path: ".harness/graph-head.json", ruleId: "harness-cache" },
      { path: ".git/harness/daemon.lock", ruleId: "harness-common-dir-state" },
      { path: ".env", ruleId: "secret-file" },
    ]
    for (const c of ruleCases) {
      const res = classifyFileWrite(c.path)
      expect(res.verdict, c.path).toBe("deny")
      expect(res.ruleId, c.path).toBe(c.ruleId)
    }

    for (const allowedPath of [
      "libs/harness/infra/src/workflow-graph-backup.ts",
      "libs/harness/infra/test/daemon-lock.test.ts",
      "libs/harness/gates/src/policy.ts",
      "apps/harness-cli/src/commands/workflow.command.ts",
      "docs/rfcs/0013-deterministic-workflow-as-code-plan-dag-orchestration.md",
    ]) {
      expect(classifyFileWrite(allowedPath).verdict, allowedPath).toBe("allow")
    }
  })

  it("SPEC-0021 REQ-3.1 / RFC-0013 REQ-4.6 denies shell mutations, redirections, and socket pokes against <git-common-dir>/harness/**", () => {
    const deniedMutateCmds = [
      "rm .git/harness/daemon.lock",
      "rm -f /path/to/repo/.git/harness/daemon.sock",
      "/bin/rm .git/harness/workflow-backups/2026-11-19.ndjson",
      "env rm .git/worktrees/wt-1/../../harness/custom.json",
      "mv .git/harness/workflow-backups/a.ndjson /tmp/a.ndjson",
      "cp /tmp/fake .git/harness/auth-tokens.json",
      "touch .git/harness/daemon.lock",
      "truncate -s 0 .git/harness/daemon.lock",
      "chmod 644 .git/harness/auth-tokens.json",
      "chown user .git/harness/daemon.sock",
      "ln -s /tmp/x .git/harness/daemon.sock",
      "dd if=/dev/zero of=.git/harness/daemon.lock",
      "mkdir -p .git/harness/workflow-backups",
      "sed -i 's/a/b/' .git/harness/workflow-backups/a.ndjson",
      "ls | tee .git/harness/daemon.lock",
      "find .git/harness -delete",
      "find .git/harness -exec rm {} +",
      "echo '{}' > .git/harness/auth-tokens.json",
      "echo x >> /repo/.git/harness/workflow-backups/a.ndjson",
      'cat /dev/null > ".git/harness/daemon.lock"',
      "ls &> .git/harness/daemon.sock",
      "ls > /tmp/ok && echo x > .git/harness/daemon.lock",
      "curl --unix-socket .git/harness/daemon.sock http://localhost/ping",
      "curl --unix-socket=/repo/.git/harness/daemon.sock http://localhost/ping",
      "nc -U .git/harness/daemon.sock",
      "ncat -U /repo/.git/harness/daemon.sock",
      "socat - UNIX-CONNECT:/repo/.git/harness/daemon.sock",
      "node -e \"fs.unlinkSync('.git/harness/daemon.lock')\"",
      "node -e \"const fs=require('fs'); fs.unlinkSync('.git/harness/daemon.lock')\"",
      "node -e \"const fs=require('fs');\nfs.unlinkSync('.git/harness/daemon.lock')\"",
      "python3 -c \"open('.git/harness/auth-tokens.json','w').write('{}')\"",
      "python3 -c \"import os; os.unlink('.git/harness/daemon.lock')\"",
      'sh -c "true; echo x > .git/harness/daemon.lock"',
      "bun -e \"require('fs').unlinkSync('.git/harness/daemon.lock')\"",
      "bun --eval \"require('fs').unlinkSync('.git/harness/daemon.lock')\"",
      "bun -p \"require('fs').readFileSync('.git/harness/daemon.lock', 'utf8')\"",
      "bun exec rm .git/harness/daemon.lock",
      'env -S "rm .git/harness/daemon.lock"',
      'env --split-string "rm .git/harness/daemon.lock"',
      'env --split-string="rm .git/harness/daemon.lock"',
      'env -S"rm .git/harness/daemon.lock"',
      "pnpm --filter @harness/contract exec rm .git/harness/daemon.lock",
      'pnpm --filter @harness/contract exec sh -c "true; rm .git/harness/daemon.lock"',
      "pnpm --filter @harness/contract exec node -e \"const fs=require('fs'); fs.unlinkSync('.git/harness/daemon.lock')\"",
      "rm .git/./harness/custom.json",
      "rm .git//harness/custom.json",
      "dd if=/dev/zero of=key=.git/./harness/custom.json",
      "socat - UNIX-CONNECT:/repo/.git/./harness/daemon.sock",
      "echo x >| .git/harness/daemon.lock",
      "echo x >|.git/harness/daemon.lock",
      "sort -o .git/harness/daemon.lock /tmp/in.txt",
      "sort -o.git/./harness/custom.json /tmp/in.txt",
      "sort --output=.git/harness/workflow-backups/a.ndjson /tmp/in.txt",
      "find . -maxdepth 1 -fprint .git/harness/daemon.lock",
      "find . -maxdepth 1 -fprint0 .git/harness/daemon.lock",
      "find . -maxdepth 1 -fprintf .git/harness/daemon.lock '%p\\n'",
      "find . -maxdepth 1 -fls .git/harness/workflow-backups/a.ndjson",
      "git diff --output=.git/harness/daemon.lock",
      "git log -n 1 --output .git/harness/workflow-backups/a.ndjson",
    ]
    for (const cmd of deniedMutateCmds) {
      expect(isHarnessStateMutationCommand(cmd), cmd).toBe(true)
      expect(classifyCommand(cmd), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd)?.ruleId, cmd).toBe("harness-state-mutation")
    }
  })

  it("SPEC-0021 REQ-3.1 / RFC-0013 REQ-4.6 denies shell reads of protected harness runtime files and auth-tokens.json while allowing benign reads and ls/find", () => {
    for (const readStateCmd of [
      "cat .git/harness/daemon.lock",
      "/bin/cat .git/harness/daemon.lock",
      "head -n 5 .git/harness/workflow-backups/2026-11-19.ndjson",
      "tail -n 5 .git/harness/daemon.sock",
      "less .git/harness/daemon.lock",
      "more .git/harness/daemon.lock",
      "strings .git/harness/daemon.lock",
      "base64 .git/harness/workflow-backups/2026-11-19.ndjson",
      "xxd .git/harness/daemon.lock",
      "od .git/harness/daemon.lock",
      "hexdump .git/harness/daemon.lock",
      "jq . .git/harness/workflow-backups/2026-11-19.ndjson",
      "pnpm --filter @harness/contract exec cat .git/harness/daemon.lock",
      "cat .git/./harness/daemon.lock",
    ]) {
      expect(classifyCommand(readStateCmd), readStateCmd).toBe("deny")
      expect(explainCommandDenyRule(readStateCmd)?.ruleId, readStateCmd).toBe(
        "harness-state-mutation",
      )
    }

    for (const secretCmd of [
      "cat auth-tokens.json",
      "cat .git/harness/auth-tokens.json",
      "cat .git/./harness/auth-tokens.json",
      "cat .harness/omnigraph-cluster/auth-tokens.json",
      "head -n 1 /path/to/repo/.git/harness/auth-tokens.json",
      "jq . .git/harness/auth-tokens.json",
    ]) {
      expect(classifyCommand(secretCmd), secretCmd).toBe("deny")
      expect(explainCommandDenyRule(secretCmd)?.ruleId, secretCmd).toBe("secret-file-access")
    }

    for (const allowedCmd of [
      "git status",
      "git diff",
      "git log -n 3",
      "pnpm harness verify",
      "pnpm harness doctor",
      "pnpm harness workflow status",
      "pnpm --filter @harness/contract test",
      "pnpm --filter @harness/contract exec vitest run",
      "pnpm oxfmt --write libs/harness/infra/src/workflow-graph-backup.ts",
      "git add libs/harness/infra/src/workflow-graph-backup.ts",
      "git commit -m 'protect .git/harness/auth-tokens.json, daemon.sock, daemon.lock, workflow-backups/'",
      "git grep 'daemon.sock' -- libs",
      "git grep 'auth-tokens.json' -- libs",
      "cat libs/harness/infra/src/workflow-graph-backup.ts",
      "sort libs/harness/gates/src/policy.ts",
      "ls .git/harness",
      "ls -i .git/harness",
      "ls -la /path/to/repo/.git/harness/workflow-backups",
      "ls .git/harness 2>/dev/null",
      "ls .git/harness 2>&1",
      "find .git/harness -maxdepth 2",
      "rg 'a > daemon.sock' libs/",
      "rg 'daemon.sock' libs/",
    ]) {
      expect(isHarnessStateMutationCommand(allowedCmd), allowedCmd).toBe(false)
      expect(classifyCommand(allowedCmd), allowedCmd).toBe("allow")
    }

    expect(isHarnessStateMutationCommand("FOO=1")).toBe(false)
    expect(classifyCommand("FOO=1")).toBe("escalate")
    expect(explainCommandDenyRule("FOO=1")).toBeUndefined()
    expect(isHarnessStateMutationCommand("ls > /tmp/ok && ls .git/harness")).toBe(false)
    expect(classifyCommand("ls > /tmp/ok && ls .git/harness")).toBe("escalate")
    expect(isHarnessStateMutationCommand("echo a >x&&ls .git/harness")).toBe(false)
    expect(classifyCommand("echo a >x&&ls .git/harness")).toBe("escalate")
  })

  it("unwraps bun, env -S, and command wrappers cleanly in unwrapCommandSegment and extractCommandSegments", () => {
    expect(unwrapCommandSegment(["bun", "-e", "console.log(1)"])).toEqual({
      envAssignments: [],
      commandWords: ["bun", "-e", "console.log(1)"],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["bun", "--", "run"])).toEqual({
      envAssignments: [],
      commandWords: ["bun", "--", "run"],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["bun", "--version"])).toEqual({
      envAssignments: [],
      commandWords: ["bun", "--version"],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["bun", "--cwd", "apps/cli", "run", "test"])).toEqual({
      envAssignments: [],
      commandWords: ["test"],
      sawPackageRunner: true,
    })
    expect(unwrapCommandSegment(["bun", "x", "nx", "test"])).toEqual({
      envAssignments: [],
      commandWords: ["nx", "test"],
      sawPackageRunner: true,
    })
    expect(unwrapCommandSegment(["env", "-S"])).toEqual({
      envAssignments: [],
      commandWords: [],
      sawPackageRunner: false,
    })
    expect(unwrapCommandSegment(["command", "-p", "--", "ls"])).toEqual({
      envAssignments: [],
      commandWords: ["ls"],
      sawPackageRunner: false,
    })
    expect(extractCommandSegments("ls&&cd /tmp").map((s) => s.commandWords)).toEqual([
      ["ls"],
      ["cd", "/tmp"],
    ])
    expect(
      extractCommandSegments('node -e "const a=1; const b=2;\nconsole.log(a+b)"').map(
        (s) => s.commandWords,
      ),
    ).toEqual([["node", "-e", "const a=1; const b=2;\nconsole.log(a+b)"]])
  })

  it("F-7.1/F-7.2/F-7.3 denies protected harness paths, custom common-dir targets, and command substitutions across any binary while preserving exemptions", () => {
    // F-7.1: arbitrary / non-allowlisted binaries targeting protected harness paths
    for (const cmd of [
      "grep foo .git/harness/daemon.lock",
      "grep -rn foo .git/harness",
      "grep foo .git/harness/custom.json",
      "diff -u .git/harness/daemon.lock /tmp/other",
      "stat .git/harness/daemon.sock",
      "wc -l .git/harness/pending-workflow-restore.json",
      "custom-bin --state .git/harness/custom.json",
      "rg foo .git/harness/daemon.lock",
      "rg -n foo .git/harness/custom.json",
      "rg -e foo .git/harness/daemon.lock",
      "rg -- -foo .git/harness/daemon.lock",
      "rg -f .git/harness/daemon.lock libs/",
      "find .git/harness -exec cat {} +",
      "find .git/harness -execdir ls {} +",
      "find .git/harness -ok rm {} \\;",
      "find .git/harness -okdir rm {} \\;",
      "find .git/harness -delete",
      "find . -maxdepth 1 -fls .git/harness/daemon.lock",
      "find . -maxdepth 1 -fprint .git/harness/daemon.lock",
      "find . -maxdepth 1 -fprint0 .git/harness/daemon.lock",
      "find . -maxdepth 1 -fprintf .git/harness/daemon.lock '%p\\n'",
      "bun harness .git/harness/daemon.lock",
    ]) {
      expect(classifyCommand(cmd), cmd).toBe("deny")
      expect(explainCommandDenyRule(cmd)?.ruleId, cmd).toBe("harness-state-mutation")
    }

    for (const secretCmd of [
      "grep foo .git/harness/auth-tokens.json",
      "rg -f .git/harness/auth-tokens.json libs/",
      "cat /custom/common-dir/harness/auth-tokens.json",
      "grep foo /custom/common-dir/harness/auth-tokens.json",
      "cat $(git rev-parse --git-common-dir)/harness/auth-tokens.json",
    ]) {
      expect(classifyCommand(secretCmd), secretCmd).toBe("deny")
      expect(explainCommandDenyRule(secretCmd)?.ruleId, secretCmd).toBe("secret-file-access")
    }

    // F-7.2: custom non-.git common-dir targets and explicit --git-common-dir / GIT_COMMON_DIR
    for (const customCommonCmd of [
      "cat /custom/common-dir/harness/daemon.sock",
      "curl --unix-socket /tmp/custom-common-dir/harness/daemon.sock http://localhost/ping",
      "cat /custom/common-dir/harness/daemon.lock",
      "cat /custom/common-dir/harness/pending-workflow-restore.json",
      "rm /custom/common-dir/harness/pending-workflow-restore.json",
      "cat /custom/common-dir/harness/custom.json",
      "GIT_COMMON_DIR=/tmp/my-repo-meta cat /tmp/my-repo-meta/harness/custom.json",
      "git --git-common-dir=/tmp/my-repo-meta diff --output=/tmp/my-repo-meta/harness/custom.json",
    ]) {
      expect(classifyCommand(customCommonCmd), customCommonCmd).toBe("deny")
      expect(explainCommandDenyRule(customCommonCmd)?.ruleId, customCommonCmd).toBe(
        "harness-state-mutation",
      )
    }

    for (const writePath of [
      "/custom/common-dir/harness/auth-tokens.json",
      "/custom/common-dir/harness/daemon.sock",
      "/custom/common-dir/harness/pending-workflow-restore.json",
      "/custom/common-dir/harness/custom.json",
    ]) {
      const res = classifyFileWrite(writePath)
      expect(res.verdict, writePath).toBe("deny")
      expect(res.ruleId, writePath).toBe("harness-common-dir-state")
    }

    // F-7.3: command substitutions targeting harness state must deny (never merely escalate)
    for (const substCmd of [
      'rm -f "$(git rev-parse --git-common-dir)/harness/daemon.lock"',
      'rm -f "$(git rev-parse --git-common-dir)/harness/custom.json"',
      "cat $(git rev-parse --git-common-dir)/harness",
      "cat `git rev-parse --git-common-dir`/harness/state.json",
      'rm -f "`git rev-parse --git-common-dir`/harness/daemon.lock"',
      'echo x > "$(git rev-parse --git-common-dir)/harness/state.json"',
      'COMMON=$(git rev-parse --git-common-dir) && cat "$COMMON/harness/state.json"',
    ]) {
      expect(classifyCommand(substCmd), substCmd).toBe("deny")
      expect(explainCommandDenyRule(substCmd)?.ruleId, substCmd).toBe("harness-state-mutation")
    }

    // F-7.1/F-7.2/F-7.3 exemptions & non-blocking normal repo source/docs/tests
    for (const allowedCmd of [
      "ls .git/harness",
      "ls -la /custom/common-dir/harness",
      "find .git/harness -maxdepth 2",
      "find .git/harness -type f",
      "pnpm harness workflow restore .git/harness/workflow-backups/2026-11-19.ndjson",
      "rg 'daemon.sock' libs/",
      "rg -n 'auth-tokens.json' libs/",
      "rg -g '*.ts' 'daemon.sock' libs/",
      "rg -e 'daemon.sock' libs/",
      "rg -- 'daemon.sock' libs/",
      "rg '$(git rev-parse --git-common-dir)/harness' libs/",
      "git commit -m 'protect .git/harness/pending-workflow-restore.json and $(git rev-parse --git-common-dir)/harness'",
      "git log --grep='.git/harness/daemon.lock' -n 5",
      "git grep 'auth-tokens.json' -- libs",
      "gh pr create --title 'protect .git/harness/daemon.lock' --body 'fixes auth-tokens.json'",
      "cat libs/harness/infra/src/workflow-graph-backup.ts",
      "cat libs/harness/gates/test/policy.test.ts",
      "cat docs/rfcs/0013-deterministic-workflow-as-code-plan-dag-orchestration.md",
    ]) {
      expect(classifyCommand(allowedCmd), allowedCmd).toBe("allow")
    }
    expect(classifyCommand("git --git-common-dir=/tmp/my-repo-meta status")).toBe("escalate")
  })
})
