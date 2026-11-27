import { describe, expect, it } from "@effect/vitest"
import { ShellCommandText } from "@harness/contract"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  PolicyFastPath,
  classifyCommand,
  classifyFileWrite,
  explainCommandDenyRule,
  isCommandAllowed,
} from "../src/index.js"
import {
  hasUnsafePnpmDirOrConfigFlags,
  isSafeFastpathToken,
  isSafePnpmDirScopedCommand,
  isSafePnpmOxfmtExplicitCommand,
  isSafeReadOnlyInspectionSegment,
  isSafeSedReadOnlyCommand,
  isSafeSemicolonReadOnlyChain,
  isSafeVitestExecTokens,
  splitCommandTokens,
} from "../src/policy-fastpath-rules.js"
import { isSafeVariableExpandedReadOnlyCommand } from "../src/policy-fastpath-var-rules.js"
import {
  splitUnquotedPipeParts,
  stripSafeLeadingEnvVarsDetailed,
} from "../src/policy-command-rules.js"
import { toCommandView } from "../src/policy-shell-parser.js"

const FastPathPropertyInput = Schema.Struct({
  kind: Schema.Literals([
    "sed-ro",
    "sed-inplace",
    "sed-exec",
    "pnpm-dir-safe",
    "pnpm-dir-unsafe",
    "semicolon-ro",
    "semicolon-unsafe",
    "var-ro",
    "var-subst",
  ]),
  target: Schema.Literals([
    "libs/harness/gates/src/policy.ts",
    "apps/harness-cli/src/index.ts",
    "libs/harness/infra/src/mutation-hmac-secret.ts",
  ]),
})

describe("SPEC-0037 REQ-4.4: Guard Fast-Path Expansion & PolicyFastPath.decide", () => {
  it("allows safe read-only sed -n commands and rejects -i, -f, write/exec scripts, and secret paths", () => {
    for (const cmd of [
      "sed -n '1,20p' libs/harness/gates/src/policy.ts",
      "sed --quiet -e '1,5p' libs/harness/gates/src/policy.ts",
      "sed --silent -n '/export/p' libs/harness/gates/src/policy.ts",
      "sed -rn 's/foo/bar/gp' libs/harness/gates/src/policy.ts",
    ]) {
      expect(isSafeSedReadOnlyCommand(splitCommandTokens(cmd)), cmd).toBe(true)
      expect(isCommandAllowed(cmd), cmd).toBe(true)
      expect(classifyCommand(cmd), cmd).toBe("allow")
    }

    for (const unsafeSed of [
      "sed -i 's/a/b/' libs/foo.ts",
      "sed -ni '1,5p' libs/foo.ts",
      "sed --in-place 's/a/b/' libs/foo.ts",
      "sed -n -f evil.sed libs/foo.ts",
      "sed -n '1e id' libs/foo.ts",
      "sed -n 's/a/b/e' libs/foo.ts",
      "sed -n '1w /tmp/out' libs/foo.ts",
      "sed -n '1W /tmp/out' libs/foo.ts",
      "sed -n '1,10p' .env",
      "sed -n '1,10p' ../../etc/passwd",
    ]) {
      expect(isSafeSedReadOnlyCommand(splitCommandTokens(unsafeSed)), unsafeSed).toBe(false)
      expect(classifyCommand(unsafeSed), unsafeSed).not.toBe("allow")
    }
    expect(classifyCommand("sed -n '1,10p' .env")).toBe("deny")
  })

  it("allows package-scoped pnpm --dir / -C for typecheck/lint/vitest/test and rejects traversal/dlx/unsafe targets", () => {
    for (const cmd of [
      "pnpm --dir libs/harness/gates test",
      "pnpm --dir libs/harness/gates run lint",
      "pnpm -C libs/harness/gates typecheck",
      "pnpm --dir=libs/harness/gates exec vitest run",
      "pnpm -C=libs/harness/gates exec -- vitest run",
      "CI=true pnpm --dir libs/harness/gates -- test",
    ]) {
      expect(isSafePnpmDirScopedCommand(cmd.replace(/^CI=true\s+/, ""), false), cmd).toBe(true)
      expect(classifyCommand(cmd), cmd).toBe("allow")
    }

    for (const unsafe of [
      "pnpm --dir ../../etc dlx evil",
      "pnpm --dir .harness test",
      "pnpm --dir .env test",
      "pnpm --dir libs/harness/gates exec node -e 'process.exit(0)'",
      "pnpm --dir libs/harness/gates run build",
      "HARNESS_WORKTREE_ID=u1 pnpm --dir apps/harness-cli test",
    ]) {
      expect(classifyCommand(unsafe), unsafe).not.toBe("allow")
    }
  })

  it("validates explicit-path pnpm oxfmt commands while blocking secrets, traversal, and repos/ subtrees", () => {
    for (const cmd of [
      "pnpm oxfmt --write libs/harness/gates/src/policy.ts",
      "CI=true pnpm oxfmt --check libs/harness/gates/src/policy.ts",
      "pnpm exec oxfmt --write libs/harness/infra/src/mutation-hmac-secret.ts",
      "pnpm exec -- oxfmt --check libs/harness/gates/src/index.ts",
    ]) {
      expect(isSafePnpmOxfmtExplicitCommand(cmd.replace(/^CI=true\s+/, "")), cmd).toBe(true)
      expect(classifyCommand(cmd), cmd).toBe("allow")
    }

    for (const unsafe of [
      "pnpm oxfmt --write .env",
      "pnpm oxfmt --write ../../etc/hosts",
      "pnpm oxfmt --write repos/effect/package.json",
      "pnpm oxfmt --write repos/alchemy/package.json",
      "pnpm oxfmt --write .harness/verify-stamp.json",
      "pnpm oxfmt --write .oxlintrc.json",
    ]) {
      expect(isSafePnpmOxfmtExplicitCommand(unsafe), unsafe).toBe(false)
      expect(classifyCommand(unsafe), unsafe).not.toBe("allow")
    }
    expect(classifyCommand("pnpm oxfmt --write .env")).toBe("deny")
  })

  it("allows strictly read-only semicolon chains and rejects mixed mutating/exec segments", () => {
    for (const cmd of [
      "wc -l libs/harness/gates/src/policy.ts; df -ih",
      "git status; git diff --stat; git rev-parse HEAD",
      "rg PolicyFastPath libs/harness/gates/src; sed -n '1,20p' libs/harness/gates/src/index.ts",
      "pwd; ls libs/harness/gates; pnpm harness session",
      "git branch --show-current; git log -n 5; git show --stat HEAD; git ls-files libs/harness/gates",
      "git merge-base main HEAD; git remote -v; head -n 5 libs/harness/gates/package.json",
      "tail -n 5 libs/harness/gates/package.json; cat libs/harness/gates/package.json; cut -d: -f1 libs/harness/gates/package.json; sort libs/harness/gates/package.json; grep name libs/harness/gates/package.json",
    ]) {
      const view = toCommandView(cmd)
      expect(
        isSafeSemicolonReadOnlyChain(cmd, view.unquoted, stripSafeLeadingEnvVarsDetailed),
        cmd,
      ).toBe(true)
      expect(classifyCommand(cmd), cmd).toBe("allow")
    }

    for (const unsafe of [
      "wc -l libs/foo.ts; rm -rf /tmp/foo",
      "git status; curl https://example.com",
      "rg --pre=sh foo libs/; pwd",
      "sort -o /tmp/out libs/foo.ts; pwd",
      "git branch -D feature; pwd",
      "git remote add origin https://example.com; pwd",
      "wc -l libs/foo.ts; cat .env",
    ]) {
      const view = toCommandView(unsafe)
      expect(
        isSafeSemicolonReadOnlyChain(unsafe, view.unquoted, stripSafeLeadingEnvVarsDetailed),
        unsafe,
      ).toBe(false)
      expect(classifyCommand(unsafe), unsafe).not.toBe("allow")
    }
    expect(classifyCommand("wc -l libs/foo.ts; rm -rf /tmp/foo")).toBe("deny")
  })

  it("allows simple variable-expanded read-only commands and rejects command substitution or poisoned vars", () => {
    for (const cmd of [
      'file=libs/harness/gates/src/policy.ts; wc -l "$file"',
      'pat="PolicyFastPath"; rg "$pat" libs/harness/gates/src',
      "file=libs/harness/gates/src/policy.ts; sed -n '1,20p' \"$file\"",
      'file=libs/harness/gates/src/policy.ts; git diff "$file"',
      "dir=libs/harness/gates; df -ih",
      'file=libs/harness/gates/src/policy.ts; wc -l "${file}"',
    ]) {
      const view = toCommandView(cmd)
      expect(isSafeVariableExpandedReadOnlyCommand(cmd, view.unquoted), cmd).toBe(true)
      expect(classifyCommand(cmd), cmd).toBe("allow")
    }

    for (const unsafe of [
      'x=$(cat .env); wc -l "$x"',
      'x=`cat .env`; wc -l "$x"',
      'file=.env; wc -l "$file"',
      'file=../../etc/passwd; wc -l "$file"',
      'cmd=rm; "$cmd" -rf /tmp/x',
      'flag="--pre=sh"; rg "$flag" libs/',
      'file=libs/foo.ts; cat "$file" > /tmp/out.txt',
      'wc -l "$unknown_var"',
    ]) {
      const view = toCommandView(unsafe)
      expect(isSafeVariableExpandedReadOnlyCommand(unsafe, view.unquoted), unsafe).toBe(false)
      expect(classifyCommand(unsafe), unsafe).not.toBe("allow")
    }
    expect(explainCommandDenyRule('x=$(cat .env); wc -l "$x"')?.ruleId).toBe("secret-file-access")
  })

  it.effect.prop(
    "PolicyFastPath.decide deterministically approves safe read-only fast-path patterns and never auto-allows adversarial bypasses",
    {
      spec: FastPathPropertyInput,
    },
    ({ spec }) =>
      Effect.gen(function* () {
        const command = match(spec.kind)
          .with("sed-ro", () => `sed -n '1,10p' ${spec.target}`)
          .with("sed-inplace", () => `sed -i 's/a/b/' ${spec.target}`)
          .with("sed-exec", () => `sed -n '1e id' ${spec.target}`)
          .with("pnpm-dir-safe", () => "pnpm --dir libs/harness/gates test")
          .with("pnpm-dir-unsafe", () => "pnpm --dir ../../etc dlx evil")
          .with("semicolon-ro", () => `wc -l ${spec.target}; df -ih`)
          .with("semicolon-unsafe", () => `wc -l ${spec.target}; rm -rf /tmp/x`)
          .with("var-ro", () => `file=${spec.target}; wc -l "$file"`)
          .with("var-subst", () => 'x=$(cat .env); wc -l "$x"')
          .exhaustive()

        const verdict = yield* PolicyFastPath.decide({ command: ShellCommandText.make(command) })
        match(spec.kind)
          .with("sed-ro", "pnpm-dir-safe", "semicolon-ro", "var-ro", () => {
            expect(verdict).toBe("allow")
          })
          .with("semicolon-unsafe", "var-subst", () => {
            expect(verdict).toBe("deny")
          })
          .with("sed-inplace", "sed-exec", "pnpm-dir-unsafe", () => {
            expect(verdict).not.toBe("allow")
          })
          .exhaustive()
      }),
  )

  it.effect("forwards unitWorkerMode to classifyCommand via PolicyFastPath.decide", () =>
    Effect.gen(function* () {
      const denyInWorker = yield* PolicyFastPath.decide({
        command: ShellCommandText.make("pnpm harness done --cli"),
        unitWorkerMode: true,
      })
      expect(denyInWorker).toBe("deny")

      const notWorkerBlocked = yield* PolicyFastPath.decide({
        command: ShellCommandText.make("pnpm harness done --cli"),
        unitWorkerMode: false,
      })
      expect(notWorkerBlocked).not.toBe("deny")
    }),
  )

  it("kills fast-path edge-case mutants across token, sed, pnpm, semicolon, and var-expansion helpers", () => {
    expect(splitCommandTokens("cat foo\\ bar.txt")).toEqual(["cat", "foo bar.txt"])
    expect(splitCommandTokens("cat foo\\")).toEqual(["cat", "foo\\"])
    expect(isSafeFastpathToken("")).toBe(false)
    expect(isSafeFastpathToken("a\nb")).toBe(false)
    expect(isSafeFastpathToken("libs/a/../b.ts")).toBe(false)
    expect(isSafeFastpathToken("libs\\..\\b.ts")).toBe(false)
    expect(isSafeFastpathToken(".env")).toBe(false)
    expect(isSafeFastpathToken("sub/.dev.vars")).toBe(false)
    expect(isSafeFastpathToken("keys/server.pem")).toBe(false)
    expect(isSafeFastpathToken("auth-token.json")).toBe(false)
    expect(isSafeFastpathToken(".env.example")).toBe(true)

    expect(isSafeSedReadOnlyCommand(["cat", "-n"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", ""])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "/unclosed"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "\\@foo@p", "libs/a.ts"])).toBe(true)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "\\", "libs/a.ts"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "\\@unclosed", "libs/a.ts"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "s/a/b/Ip;p", "libs/a.ts"])).toBe(true)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "y/abc/xyz/;p", "libs/a.ts"])).toBe(true)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "y/a/b/I", "libs/a.ts"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "s/a/b/gp;w", "libs/a.ts"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "s /a/b/", "libs/a.ts"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "s/a", "libs/a.ts"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "s/a/b", "libs/a.ts"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "--expression"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-n", "-e"])).toBe(false)
    expect(isSafeSedReadOnlyCommand(["sed", "-rn", "1p", "libs/a.ts"])).toBe(true)
    expect(isSafeSedReadOnlyCommand(["sed", "-n"])).toBe(false)

    expect(isSafePnpmDirScopedCommand("npm --dir libs/a test", false)).toBe(false)
    expect(isSafePnpmDirScopedCommand("pnpm --dir", false)).toBe(false)
    expect(isSafePnpmDirScopedCommand("pnpm --dir libs/a --script-shell=sh test", false)).toBe(
      false,
    )
    expect(isSafePnpmDirScopedCommand("pnpm --dir libs/a --filter", false)).toBe(false)
    expect(isSafePnpmDirScopedCommand("pnpm --dir libs/a -- test", false)).toBe(true)
    expect(isSafePnpmDirScopedCommand("pnpm --dir libs/a exec -- test", false)).toBe(true)
    expect(isSafePnpmDirScopedCommand("pnpm --dir libs/a test -- --reporter=dot", false)).toBe(true)
    expect(isSafePnpmDirScopedCommand("pnpm --dir libs/a test -- --skip-nx-cache", false)).toBe(
      false,
    )

    expect(isSafePnpmOxfmtExplicitCommand("oxfmt --write libs/a.ts")).toBe(false)
    expect(isSafePnpmOxfmtExplicitCommand("pnpm oxfmt --list-different libs/a.ts")).toBe(true)
    expect(isSafePnpmOxfmtExplicitCommand("pnpm oxfmt --threads=4 --write libs/a.ts")).toBe(true)
    expect(isSafePnpmOxfmtExplicitCommand("pnpm oxfmt --bad --write libs/a.ts")).toBe(false)

    for (const [cmd, expected] of [
      ["git foo; pwd", false],
      ["git status --output=/tmp/x; pwd", false],
      ["sed -n '1p' libs/a.ts; pwd", true],
      ["rg --pre=sh x libs/; pwd", false],
      ["wc -l libs/a.ts; sort libs/a.ts", true],
      ["wc -l libs/a.ts; sort -o /tmp/x libs/a.ts", false],
      ["pnpm harness session; pwd", true],
      ["HARNESS_WORKTREE_ID=w1 pnpm harness session; pwd", false],
      ["wc -l libs/a.ts | sed -n '1p'; pwd", true],
      ["wc -l libs/a.ts | sed -i 's/a/b/'; pwd", false],
      ["wc -l libs/a.ts | rg foo; pwd", true],
      ["wc -l libs/a.ts | rg --pre=sh foo; pwd", false],
      ["wc -l libs/a.ts | sort; pwd", true],
      ["wc -l libs/a.ts | sort -o /tmp/x; pwd", false],
    ] as const) {
      const view = toCommandView(cmd)
      expect(
        isSafeSemicolonReadOnlyChain(
          cmd,
          view.unquoted,
          stripSafeLeadingEnvVarsDetailed,
          splitUnquotedPipeParts,
        ),
        cmd,
      ).toBe(expected)
    }

    expect(isSafeReadOnlyInspectionSegment("", stripSafeLeadingEnvVarsDetailed)).toBe(false)
    expect(
      isSafeReadOnlyInspectionSegment(
        "wc -l libs/a.ts | head -n 5",
        stripSafeLeadingEnvVarsDetailed,
        splitUnquotedPipeParts,
      ),
    ).toBe(true)

    for (const [cmd, expected] of [
      ['file=libs/a.ts; sort "$file"', false],
      ['file=libs/a.ts; wc -l "${file}"', true],
      ['file=libs/a.ts; wc -l "${file"', false],
      ['file=libs/a.ts; wc -l "${nope}"', false],
      ['file=libs/a.ts; wc -l "$1"', false],
      ["file=libs/a.ts; wc -l $1", false],
      ["file=libs/a.ts; wc -l '${UNSET}x'", true],
      ["file=libs/a.ts; wc -l 'x$UNSET'", true],
      ['file=libs/a.ts; rg "a$" "$file"', true],
      ['file=libs/a.ts; rg "a\\nb" "$file"', true],
      ['file=libs/a.ts; rg "a\\" "$file"', false],
      ['file=libs/a.ts; rg a\\ b "$file"', true],
      ['file=libs/a.ts; rg foo\\ "$file"', true],
      ["file=libs/a.ts; rg foo\\", true],
      ['file=libs/a.ts;; wc -l "$file"', false],
      ["file=libs/a.ts; ", false],
      ["file=libs/a.ts\n", false],
      ['a="$b"; wc -l "$a"', false],
      ['file=libs/a.ts; wc -l "$nope"', false],
      ['sub=diff; git "$sub" libs/a.ts', false],
    ] as const) {
      const view = toCommandView(cmd)
      expect(isSafeVariableExpandedReadOnlyCommand(cmd, view.unquoted), cmd).toBe(expected)
    }

    for (const bypassCmd of [
      "X='foo --pre=sh'; rg $X libs/",
      "X='HEAD --output=evil.ts'; git diff $X",
      "X='foo server.key'; wc -l $X",
      "X=libs/harness/gates/src/policy.ts; wc -l $X",
      "echo 'id #a' | sed -n 's/[a/b]/;/e;#/'",
      "pnpm --dir /tmp/evil test",
      "pnpm --config=/tmp/evil.npmrc --dir libs/harness/gates test",
      "pnpm --dir libs/harness/gates exec vitest --config /tmp/evil.config.ts",
      "pnpm oxfmt --write /tmp/outside.ts",
      "sed -n '1p' /etc/passwd",
      "git branch -f main HEAD~1; pwd",
      "git branch rogue-branch; pwd",
      'P=libs/harness/gates/src/policy.ts; wc -l "$P" | bash',
      'P=libs/harness/gates/src/policy.ts; wc -l "$P" < /etc/passwd',
      "vitest --config /tmp/evil.config.ts",
      "pnpm vitest --config /tmp/evil.config.ts",
      "pnpm -C libs/harness/gates exec oxfmt --write /tmp/outside.ts",
      "pnpm --filter @harness/gates exec oxfmt --write /tmp/outside.ts",
    ]) {
      expect(classifyCommand(bypassCmd), bypassCmd).not.toBe("allow")
    }
    expect(classifyCommand("sed -n 's/[a/b]/;/e;#/' libs/a.ts")).not.toBe("allow")
    expect(isSafeSedReadOnlyCommand(splitCommandTokens("sed -n '#' libs/a.ts"))).toBe(false)
    for (const safeSed of [
      "sed -n 's/[[:alpha:]\\/]/x/' libs/a.ts",
      "sed -n 's/[[:alpha:]/]/x/' libs/a.ts",
      "sed -n 's/[[=a=]/]/x/' libs/a.ts",
      "sed -n 's/[[.a.]/]/x/' libs/a.ts",
      "sed -n 's/[[:a]/x/' libs/a.ts",
      "sed -n 's/[]/]/x/' libs/a.ts",
    ]) {
      expect(classifyCommand(safeSed), safeSed).toBe("allow")
    }
    expect(isSafeSedReadOnlyCommand(splitCommandTokens("sed -n 's/[^]/]/x/' libs/a.ts"))).toBe(true)
    expect(isSafeSedReadOnlyCommand(splitCommandTokens("sed -n 's/[^]/]/x/;e' libs/a.ts"))).toBe(
      false,
    )
    expect(classifyCommand("git branch --contains=HEAD; pwd")).toBe("allow")
    expect(classifyCommand("git branch --contains=.env; pwd")).not.toBe("allow")
    expect(
      isSafeReadOnlyInspectionSegment(
        "git branch --contains=.env",
        stripSafeLeadingEnvVarsDetailed,
        splitUnquotedPipeParts,
      ),
    ).toBe(false)
    expect(classifyCommand("git branch --contains HEAD; pwd")).toBe("allow")
    expect(classifyCommand("git branch --contains; pwd")).not.toBe("allow")
    expect(classifyCommand("git branch --contains .env; pwd")).not.toBe("allow")
    expect(isSafeVitestExecTokens(["vitest", "run", "--run"])).toBe(true)
    expect(isSafeVitestExecTokens(["vitest", "--config", "libs/evil.config.ts"])).toBe(false)

    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "--", "--config=/tmp/x"])).toBe(false)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "--config=/tmp/x", "test"])).toBe(true)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "--dir", "libs/a", "test"])).toBe(false)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "--dir", "/tmp/evil", "test"])).toBe(true)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "--dir=/tmp/evil", "test"])).toBe(true)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "-C=/tmp/evil", "test"])).toBe(true)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "-C=libs/a", "test"])).toBe(false)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "-C/tmp/evil", "test"])).toBe(true)
    expect(hasUnsafePnpmDirOrConfigFlags(["pnpm", "-Clibs/a", "test"])).toBe(false)
    expect(isSafePnpmDirScopedCommand("pnpm --dir /tmp/evil test", false)).toBe(false)

    expect(classifyFileWrite(".harness/hook-runtime/current/manifest.json").verdict).toBe("deny")
    expect(classifyCommand("rm -rf .harness/hook-runtime/current")).toBe("deny")
  })

  it("rejects env-var overrides, &&/||/newline/multi-consumer chaining, unsafe ${VAR} forms, and dangerous git flags (F-1.1, F-1.2)", () => {
    for (const unsafeVarCmd of [
      "HOME=tmp; git status",
      "PATH=scripts; wc README.md",
      "IFS=x; wc README.md",
      "GIT_CONFIG_GLOBAL=tmp; git status",
      "LD_PRELOAD=tmp/evil.so; wc README.md",
      "NODE_OPTIONS=--require=x; wc README.md",
      "XDG_CONFIG_HOME=tmp; git diff",
      "SHELL=/bin/sh; wc README.md",
      "ENV=tmp; wc README.md",
      "BASH_ENV=tmp; wc README.md",
      "TMPDIR=tmp; wc README.md",
      'FILE=libs/harness/gates/src/policy.ts; wc -l "$FILE"',
      'MyVar=libs/harness/gates/src/policy.ts; wc -l "$MyVar"',
      "HOME=tmp && git diff",
      'file=libs/harness/gates/src/policy.ts && wc -l "$file"',
      'file=libs/harness/gates/src/policy.ts || wc -l "$file"',
      'file=libs/harness/gates/src/policy.ts\nwc -l "$file"',
      'file=libs/harness/gates/src/policy.ts; wc -l "$file"; rg PolicyFastPath libs/harness/gates/src',
      "file=libs/harness/gates/src/policy.ts; wc -l ${file}",
      'file=libs/harness/gates/src/policy.ts; wc -l "${file:-evil}"',
      'file=libs/harness/gates/src/policy.ts; wc -l "${HOME}"',
    ]) {
      const view = toCommandView(unsafeVarCmd)
      expect(isSafeVariableExpandedReadOnlyCommand(unsafeVarCmd, view.unquoted), unsafeVarCmd).toBe(
        false,
      )
      const verdict = classifyCommand(unsafeVarCmd)
      expect(verdict, unsafeVarCmd).not.toBe("allow")
      expect(["escalate", "deny"]).toContain(verdict)
    }

    for (const unsafeGitCmd of [
      "git status -c core.fsmonitor=evil; pwd",
      "git diff -c=core.fsmonitor=evil; pwd",
      "git diff --config-env=GIT_EXTERNAL_DIFF=evil; pwd",
      "git diff --config-env GIT_EXTERNAL_DIFF=evil; pwd",
      "git diff --ext-diff; pwd",
      "git diff --ext-diff=evil; pwd",
      "git diff --textconv; pwd",
      "git show --textconv HEAD; pwd",
      "git status --exec-path=/tmp/evil; pwd",
      "git status --exec-path /tmp/evil; pwd",
      "git status --git-dir=/tmp/evil; pwd",
      "git status --work-tree=/tmp/evil; pwd",
      "git status --upload-pack=/tmp/evil; pwd",
      'file=libs/harness/gates/src/policy.ts; git diff --ext-diff "$file"',
      'file=libs/harness/gates/src/policy.ts; git diff -c core.pager=sh "$file"',
      "git diff --ext-diff",
      "git diff --textconv",
      "git show --ext-diff HEAD",
      "git log --textconv -n 1",
    ]) {
      expect(classifyCommand(unsafeGitCmd), unsafeGitCmd).not.toBe("allow")
    }
  })
})
