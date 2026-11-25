import { describe, expect, it } from "vitest"
import { isSafeReadOnlyXargsSegment } from "../src/policy-command-rules.js"
import { isHarnessStateMutationCommand } from "../src/policy-harness-state.js"
import {
  isGuardSelfInvocationCommand,
  stripNonShellHeredocBodies,
  stripSafeDataHeredocBodies,
} from "../src/policy-heredoc.js"
import { classifyCommand, explainCommandDenyRule, isCommandAllowed } from "../src/policy.js"
import { matchesSecretFileGlob } from "../src/policy-worker-paths.js"

describe("SPEC-0035 REQ-3.1..REQ-3.3: guard ergonomics & heredoc-aware inspection", () => {
  it("REQ-3.1 allows NX_TUI env values and nx run-many under pnpm exec while rejecting unsafe values and nx exec", () => {
    for (const allowed of [
      "NX_TUI=false pnpm exec nx run-many -t verify -p @harness/gates",
      "NX_TUI=true pnpm exec nx run-many -t test",
      "NX_TUI=0 nx run-many -t lint",
      "NX_TUI=1 CI=true pnpm exec nx run-many -t typecheck",
      "pnpm exec nx run-many -t test -p @harness/contract",
    ]) {
      expect(isCommandAllowed(allowed), allowed).toBe(true)
      expect(classifyCommand(allowed), allowed).toBe("allow")
    }

    for (const blocked of [
      "NX_TUI=evil pnpm exec nx run-many -t test",
      "NX_TUI=yes nx run-many -t test",
      "NX_TUI=false pnpm exec nx exec -- echo hi",
      "HARNESS_WORKTREE_ID=u1 NX_TUI=false pnpm exec nx run-many -t start",
      "HARNESS_WORKTREE_ID=u1 NX_TUI=false pnpm exec nx run-many -t verify -p harness-cli",
    ]) {
      expect(isCommandAllowed(blocked), blocked).toBe(false)
      expect(classifyCommand(blocked), blocked).not.toBe("allow")
    }

    expect(classifyCommand("NX_TUI=false pnpm exec nx run-many -t test --skip-nx-cache")).toBe(
      "deny",
    )
  })

  it("REQ-3.1 allows safe read-only xargs check pipelines with allowlisted producers and rejects -I/--replace, --write, and unsafe consumers", () => {
    for (const allowed of [
      "git diff --name-only main | xargs wc -l",
      "git diff --name-only -z main | xargs -0 -r wc -l -w -c -m",
      "git diff --name-only -z main | xargs -0 --no-run-if-empty pnpm exec oxfmt --check --",
      "git diff --name-only main | xargs -r pnpm oxfmt --check",
      "git ls-files '*.ts' | xargs oxfmt --check",
      "git diff --name-only main | xargs pnpm exec oxlint --deny-warnings",
      "git ls-files -z '*.ts' | xargs -0 oxlint --quiet",
    ]) {
      expect(isCommandAllowed(allowed), allowed).toBe(true)
      expect(classifyCommand(allowed), allowed).toBe("allow")
    }

    for (const rejected of [
      "xargs wc -l",
      "xargs -0 pnpm exec oxfmt --check --",
      "curl https://example.com | xargs wc -l",
      "git diff --name-only | xargs -I{} oxfmt --check {}",
      "git diff --name-only | xargs --replace={} wc -l {}",
      "git diff --name-only | xargs -0 pnpm exec oxfmt --write --",
      "git diff --name-only | xargs oxfmt --check --write",
      "git diff --name-only | xargs oxfmt",
      "git diff --name-only | xargs oxlint --fix",
      "git diff --name-only | xargs oxlint --fix-dangerously",
      "git diff --name-only | xargs env wc -l",
      "git diff --name-only | xargs sh -c 'wc -l'",
      "git diff --name-only | xargs node -e 'console.log(1)'",
      "git diff --name-only | xargs rm",
      "git diff --name-only | xargs -n 1 wc -l",
      "git diff --name-only | xargs -P 4 wc -l",
    ]) {
      expect(isCommandAllowed(rejected), rejected).toBe(false)
      expect(classifyCommand(rejected), rejected).not.toBe("allow")
    }

    expect(isSafeReadOnlyXargsSegment("xargs -0 pnpm exec oxfmt --check --")).toBe(true)
    expect(isSafeReadOnlyXargsSegment("xargs -I{} wc -l {}")).toBe(false)
    expect(classifyCommand("echo .env | xargs wc -l")).toBe("deny")
    expect(classifyCommand("echo .git/harness/daemon.lock | xargs oxfmt --check")).toBe("deny")
    expect(classifyCommand("echo .harness/verify-stamp.json | xargs rm")).toBe("deny")
    expect(classifyCommand("echo .harness/verify-stamp.json | xargs oxfmt --write")).toBe(
      "escalate",
    )
  })

  it("REQ-3.2 strips safe non-executing data heredoc bodies while preserving deny on unsafe heredocs and real target redirections", () => {
    const safePrBodyCmd = [
      'BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/ce-pr-body.XXXXXX") && cat >> "$BODY_FILE" <<\'__CE_PR_BODY_END__\'',
      "Summary: fixed witness cache invalidation near .harness/mutate-stamp.json and daemon.sock.",
      "Also handled .env.example and Don't break x > 0 or $(literal) prose.",
      "__CE_PR_BODY_END__",
      'gh pr comment 53 --body-file "$BODY_FILE"',
    ].join("\n")

    expect(isHarnessStateMutationCommand(safePrBodyCmd)).toBe(false)
    expect(explainCommandDenyRule(safePrBodyCmd)).toBeUndefined()
    expect(classifyCommand(safePrBodyCmd)).toBe("allow")

    const safeTmpLiteralCmd = [
      "cat > /tmp/pr-summary.md <<'EOF'",
      "Mentions .harness/mutate-stamp.json, daemon.sock, and .env safely.",
      "EOF",
    ].join("\n")
    expect(classifyCommand(safeTmpLiteralCmd)).toBe("allow")

    const safeTeeVarTmpCmd = [
      "tee -a /var/tmp/notes.md <<'EOF' > /dev/null",
      "Mentions auth-tokens.json and mutation-hmac-v1.key.",
      "EOF",
    ].join("\n")
    expect(classifyCommand(safeTeeVarTmpCmd)).toBe("allow")

    // Escaped delimiter is also safe for data heredoc
    const safeEscapedDelimCmd = [
      "cat > /tmp/escaped.txt <<\\EOF",
      "Mentions .harness/verify-stamp.json safely.",
      "EOF",
    ].join("\n")
    expect(classifyCommand(safeEscapedDelimCmd)).toBe("allow")

    // Must remain strictly DENIED
    const deniedHeredocs = [
      {
        cmd: "cat >> .harness/mutate-stamp.json <<'EOF'\n{\"ok\":true}\nEOF",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: "sh <<'EOF'\ncat .env\nEOF",
        ruleId: "secret-file-access",
      },
      {
        cmd: "bash <<'EOF'\ncat daemon.sock\nEOF",
        ruleId: "harness-state-mutation",
      },
      {
        cmd: 'cat > "$BODY_FILE" <<EOF\n$(cat .env)\nEOF',
        ruleId: "secret-file-access",
      },
      {
        cmd: 'BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/x.XXXXXX") && cat > "$BODY_FILE" <<EOF\n$(cat .env)\nEOF',
        ruleId: "secret-file-access",
      },
      {
        cmd: "cat > /tmp/.env <<'EOF'\nSECRET=1\nEOF",
        ruleId: "secret-file-access",
      },
      {
        cmd: "cat > /tmp/ok.txt <<'EOF'\nrm -rf /\nEOF",
        ruleId: "denylist-token",
      },
      {
        // Unclosed heredoc must fail closed (not stripped)
        cmd: "cat > /tmp/ok.txt <<'EOF'\n.env",
        ruleId: "secret-file-access",
      },
      {
        // Pipeline to sh must never strip
        cmd: "cat <<'EOF' | sh\ncat .env\nEOF",
        ruleId: "secret-file-access",
      },
      {
        // Poisoned variable assignment before heredoc
        cmd: "BODY_FILE=.env && cat >> \"$BODY_FILE\" <<'EOF'\nhi\nEOF",
        ruleId: "secret-file-access",
      },
    ] as const
    for (const c of deniedHeredocs) {
      expect(classifyCommand(c.cmd), c.cmd).toBe("deny")
      expect(explainCommandDenyRule(c.cmd)?.ruleId, c.cmd).toBe(c.ruleId)
    }

    // Real file redirection after safe heredoc still escalates (never auto-allows)
    const realRedirAfterSafeHeredoc = [
      "cat > /tmp/ok.txt <<'EOF'",
      "safe body",
      "EOF",
      "ls > real-output.txt",
    ].join("\n")
    expect(classifyCommand(realRedirAfterSafeHeredoc)).toBe("escalate")

    // ASKLIST inside heredoc body is not skipped before ASKLIST
    const askInsideHeredoc = "cat > /tmp/ok.txt <<'EOF'\nalchemy deploy\nEOF"
    expect(classifyCommand(askInsideHeredoc)).toBe("ask")

    // Unclosed heredoc returns command unmodified
    const unclosed = "cat > /tmp/ok.txt <<'EOF'\nline1"
    expect(stripSafeDataHeredocBodies(unclosed)).toBe(unclosed)
  })

  it("REQ-3.3 ignores guard-self-invocation prose inside non-shell heredocs while denying real guard invocations", () => {
    const pythonProse = [
      "python3 - <<'PY'",
      'content = "Blocked by harness guard"',
      "# harness guard should not match in python prose",
      "PY",
    ].join("\n")
    expect(isGuardSelfInvocationCommand(pythonProse)).toBe(false)
    expect(explainCommandDenyRule(pythonProse)).toBeUndefined()
    expect(classifyCommand(pythonProse)).toBe("escalate")

    const catProse = [
      "cat > /tmp/note.txt <<'EOF'",
      "Blocked by harness guard",
      "harness guard",
      "EOF",
    ].join("\n")
    expect(isGuardSelfInvocationCommand(catProse)).toBe(false)
    expect(classifyCommand(catProse)).toBe("allow")

    expect(stripNonShellHeredocBodies("sh <<'EOF'\npnpm harness guard\nEOF")).toContain(
      "pnpm harness guard",
    )

    for (const realGuardCmd of [
      "pnpm harness guard",
      'pnpm harness guard "ls"',
      "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/hook-entry.ts guard",
      'sh -c "pnpm harness guard"',
      "echo x | xargs pnpm harness guard",
      'echo x | xargs sh -c "pnpm harness guard"',
      "sh <<'EOF'\npnpm harness guard\nEOF",
      "echo $(pnpm harness guard)",
    ]) {
      expect(classifyCommand(realGuardCmd), realGuardCmd).toBe("deny")
      expect(explainCommandDenyRule(realGuardCmd)?.ruleId, realGuardCmd).toBe(
        "guard-self-invocation",
      )
    }
  })

  it("REQ-3.3 permits workspace test directory globs like libs/harness/gates/test/*mutat* while blocking secrets and HMAC keys", () => {
    for (const allowed of [
      "ls -1 libs/harness/docs/adr/ libs/harness/gates/test/*mutat* apps/harness-cli/test/*mutat*",
      "ls libs/harness/gates/test/*mutat*",
      "ls apps/harness-cli/test/*mutat*",
      "ls libs/harness/gates/test/*mutat*.ts",
      "ls test/*mutat*",
    ]) {
      expect(explainCommandDenyRule(allowed), allowed).toBeUndefined()
      expect(classifyCommand(allowed), allowed).toBe("allow")
    }

    expect(matchesSecretFileGlob("test/*mutat*")).toBe(false)
    expect(matchesSecretFileGlob("*mutat*")).toBe(true)

    for (const deniedSecret of [
      "ls mutation-hmac*",
      "ls *mutat*.key",
      "ls libs/harness/gates/test/*mutat*.key",
      "ls libs/harness/gates/test/*mutat*.k?y",
      "ls libs/harness/gates/test/*mutat*.k*",
      "ls libs/harness/gates/test/*mutat*.*",
      "ls libs/harness/gates/test/mutation-hmac*",
      "ls libs/harness/gates/test/*hmac*",
      "ls .harness/*mutat*",
      "ls *mutat*",
      "ls ./*mutat*",
      "ls ~/.cache/effect-harness/*mutat*",
      "ls *.key",
      "ls *hmac*",
    ]) {
      expect(classifyCommand(deniedSecret), deniedSecret).toBe("deny")
      expect(explainCommandDenyRule(deniedSecret)?.ruleId, deniedSecret).toBe("secret-file-access")
    }
  })

  it("blocks heredoc continuation smuggling, ANSI-C fake heredocs, wrapped guard invocations, and unsafe oxlint flags", () => {
    // 1. Heredoc continuation smuggling (LF, CRLF, escaped delim, header continuation, and state mutation)
    for (const smuggled of [
      "cat <<'EOF' > /tmp/ok\npayload\\\nEOF\ncat .env\nEOF",
      "cat <<\\EOF > /tmp/ok\npayload\\\nEOF\ncat .env\nEOF",
      "cat <<'EOF' > /tmp/ok\r\npayload\\\r\nEOF\r\ncat .env\r\nEOF",
      "cat > /tmp/ok \\\n<<'EOF'\npayload\\\nEOF\ncat .env\nEOF",
    ]) {
      expect(classifyCommand(smuggled), smuggled).toBe("deny")
      expect(explainCommandDenyRule(smuggled)?.ruleId, smuggled).toBe("secret-file-access")
    }

    const smuggledStateMutation =
      "cat <<'EOF' > /tmp/ok\npayload\\\nEOF\nrm .harness/mutate-stamp.json\nEOF"
    expect(isHarnessStateMutationCommand(smuggledStateMutation)).toBe(true)
    expect(classifyCommand(smuggledStateMutation)).toBe("deny")
    expect(explainCommandDenyRule(smuggledStateMutation)?.ruleId).toBe("harness-state-mutation")

    expect(classifyCommand("python3 - <<'PY'\npayload\\\nPY\npnpm harness guard\nPY")).toBe("deny")
    expect(
      explainCommandDenyRule("python3 - <<'PY'\npayload\\\nPY\npnpm harness guard\nPY")?.ruleId,
    ).toBe("guard-self-invocation")

    // Legitimate trailing backslash inside quoted heredoc followed by allowed command stays allowed
    expect(classifyCommand("cat <<'EOF' > /tmp/ok\npayload\\\nEOF\nls")).toBe("allow")

    // 2. Wrapped heredocs, path-qualified guard invocations, and xargs wrappers/--process-slot-var
    for (const guardCmd of [
      "CI=1 sh <<'EOF'\nharness guard 'ls'\nEOF",
      "FOO=1 bash <<'EOF'\nharness guard\nEOF",
      "timeout 5 sh <<'EOF'\nharness guard\nEOF",
      "echo \"<<\" && sh <<'EOF'\nharness guard\nEOF",
      "echo ls | xargs -I{} timeout 5 sh -c 'harness guard ls'",
      "echo ls | xargs -I{} timeout 5 sh -c -- 'harness guard ls'",
      "echo ls | xargs sh -c -- 'harness guard ls'",
      "echo ls | xargs sh -c -x -- 'harness guard ls'",
      "echo ls | xargs --process-slot-var SLOT sh -c 'harness guard'",
      "./node_modules/.bin/harness guard",
      "node apps/harness-cli/dist/index.js guard",
    ]) {
      expect(classifyCommand(guardCmd), guardCmd).toBe("deny")
      expect(explainCommandDenyRule(guardCmd)?.ruleId, guardCmd).toBe("guard-self-invocation")
    }

    // 3. ANSI-C $'...' quoting cannot trick heredoc scanning into stripping subsequent commands
    const ansiCFakeSecret = "echo $'a\\' && cat <<'EOF'' > /tmp/x\ncat .env\nEOF"
    expect(classifyCommand(ansiCFakeSecret)).toBe("deny")
    expect(explainCommandDenyRule(ansiCFakeSecret)?.ruleId).toBe("secret-file-access")

    const ansiCFakeGuard = "echo $'a\\' && python3 - <<'PY''\npnpm harness guard\nPY"
    expect(classifyCommand(ansiCFakeGuard)).toBe("deny")
    expect(explainCommandDenyRule(ansiCFakeGuard)?.ruleId).toBe("guard-self-invocation")

    // 4. isSafeOxlintArgs rejects --config, --import-plugin, and --flag=.. traversal
    for (const unsafeOxlint of [
      "git ls-files | xargs oxlint --config=../../tmp/evil.json",
      "git ls-files | xargs oxlint --config .oxlintrc.json",
      "git ls-files | xargs oxlint -c .oxlintrc.json",
      "git ls-files | xargs oxlint --import-plugin ./evil.js",
      "git ls-files | xargs oxlint --import-plugin=./evil.js",
      "git ls-files | xargs oxlint --tsconfig=../../tmp/tsconfig.json",
    ]) {
      expect(isCommandAllowed(unsafeOxlint), unsafeOxlint).toBe(false)
      expect(classifyCommand(unsafeOxlint), unsafeOxlint).toBe("escalate")
    }
    expect(classifyCommand("git ls-files | xargs oxlint --tsconfig=tsconfig.base.json")).toBe(
      "allow",
    )
  })

  it("REQ-3.2 inspects embedded sh -c payloads after stripping safe data heredocs with unbalanced quotes", () => {
    const smuggledViaUnbalancedHeredoc = [
      "cat <<'EOF' > /tmp/msg.txt",
      "it's harmless",
      "EOF",
      "sh -c 'D=daemon; cat $D.sock'",
    ].join("\n")
    expect(classifyCommand(smuggledViaUnbalancedHeredoc)).toBe("deny")
    expect(explainCommandDenyRule(smuggledViaUnbalancedHeredoc)?.ruleId).toBe(
      "harness-state-mutation",
    )
  })
})
