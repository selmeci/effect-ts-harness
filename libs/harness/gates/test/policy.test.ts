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

  // harness:SPEC-0001 · 1 — destructive arguments on allowlisted binaries
  it("REQ-1.1 escalates find actions that delete or execute", () => {
    expect(classifyCommand("find packages/app/dist -depth -delete")).toBe("escalate")
    expect(classifyCommand("find packages/app/dist -delete")).toBe("escalate")
    expect(classifyCommand("find . -name '*.log' -exec rm {} +")).toBe("escalate")
    expect(classifyCommand("find . -type f -execdir rm {} \\;")).toBe("escalate")
    expect(classifyCommand("find dist -ok rm {} \\;")).toBe("escalate")
    expect(classifyCommand("find dist -okdir rm {} \\;")).toBe("escalate")
    // quoted flags (review F-01)
    expect(classifyCommand("find packages/app/dist -depth '-delete'")).toBe("escalate")
    expect(classifyCommand("find . '-exec' rm {} +")).toBe("escalate")
  })

  it("REQ-1.2 asks a human before git commands that discard state", () => {
    expect(classifyCommand("git checkout -- .")).toBe("ask")
    expect(classifyCommand("git checkout -- libs/harness/gates/src/policy.ts")).toBe("ask")
    expect(classifyCommand("git checkout .")).toBe("ask")
    expect(classifyCommand("git checkout -f main")).toBe("ask")
    expect(classifyCommand("git restore .")).toBe("ask")
    expect(classifyCommand("git restore --staged -- src/a.ts")).toBe("ask")
    expect(classifyCommand("git stash drop")).toBe("ask")
    expect(classifyCommand("git stash clear")).toBe("ask")
    expect(classifyCommand("git branch -D feat/old")).toBe("ask")
    expect(classifyCommand("git branch --delete feat/old")).toBe("ask")
    expect(classifyCommand("git branch -d feat/old")).toBe("ask")
    expect(classifyCommand("git clean -fd")).toBe("ask")
    expect(classifyCommand("git switch --discard-changes main")).toBe("ask")
    expect(classifyCommand("git switch -f main")).toBe("ask")
    expect(classifyCommand("git reset --hard HEAD~1")).toBe("ask")
    // quoted flags / paths (review F-09)
    expect(classifyCommand("git checkout '.'")).toBe("ask")
    expect(classifyCommand("git checkout ./")).toBe("ask")
    expect(classifyCommand("git checkout '-f' main")).toBe("ask")
    expect(classifyCommand("git branch '-D' feat/old")).toBe("ask")
    expect(classifyCommand("git push origin --delete feat/old")).toBe("ask")
  })

  it("REQ-1.3 escalates output redirection into a file", () => {
    expect(classifyCommand("cat package.json > /tmp/out.json")).toBe("escalate")
    expect(classifyCommand("ls >> notes.txt")).toBe("escalate")
    expect(classifyCommand("git log -n 5 >out.txt")).toBe("escalate")
    expect(classifyCommand("ls 2> err.txt")).toBe("escalate")
    // combined redirections (review F-02)
    expect(classifyCommand("cat package.json &> /tmp/out.json")).toBe("escalate")
    expect(classifyCommand("ls &> notes.txt")).toBe("escalate")
    expect(classifyCommand("git log >& out.txt")).toBe("escalate")
  })

  it("REQ-1.4 escalates destructive first segments instead of the read-only pipe allowance", () => {
    expect(classifyCommand("find dist -delete | head")).toBe("escalate")
    expect(classifyCommand("find . -exec rm {} + | wc -l")).toBe("escalate")
    expect(classifyCommand("git log > log.txt | head")).toBe("escalate")
    expect(classifyCommand("git checkout . | head")).toBe("ask")
  })

  it("REQ-1.5 keeps read-only find, branch creation and harmless redirections allowed", () => {
    expect(classifyCommand("find libs -name '*.ts' -not -path '*/node_modules/*'")).toBe("allow")
    expect(classifyCommand("find . -maxdepth 2 -type d -name dist")).toBe("allow")
    expect(classifyCommand("find . -name '*.deleted.ts'")).toBe("allow")
    expect(classifyCommand("git checkout -b feat/new main")).toBe("allow")
    expect(classifyCommand("git checkout main")).toBe("allow")
    expect(classifyCommand("git switch main")).toBe("allow")
    expect(classifyCommand("git branch -a")).toBe("allow")
    expect(classifyCommand("git stash list")).toBe("allow")
    expect(classifyCommand("git add libs/harness && git commit -m 'feat: x'")).toBe("escalate")
    expect(classifyCommand("git commit -m 'feat(harness): guard hardening'")).toBe("allow")
    expect(classifyCommand("git push -u origin HEAD")).toBe("allow")
    expect(classifyCommand("git fetch --no-tags origin main")).toBe("allow")
    expect(classifyCommand('gh pr create --title "fix: count > 0 and .env" --body-file /tmp/body.md')).toBe("allow")
    expect(classifyCommand("find libs -name '*.ts' 2>/dev/null")).toBe("allow")
    expect(classifyCommand("ls missing 2>&1")).toBe("allow")
    expect(classifyCommand("ls > /dev/null")).toBe("allow")
    // quoted '>' and data arguments in commit / grep (review F-01, F-06)
    expect(classifyCommand("git grep 'Array<string>' -- libs")).toBe("allow")
    expect(classifyCommand("git grep '<div>' -- apps")).toBe("allow")
    expect(classifyCommand("git commit -m 'fix: count > 0 check'")).toBe("allow")
    expect(classifyCommand("git commit -m 'fix: find -delete edge case'")).toBe("allow")
    expect(classifyCommand("git grep 'find -delete' -- libs")).toBe("allow")
  })

  // harness:SPEC-0001 · 2 — guard self-invocation
  it("REQ-2.1 denies agent-initiated calls of the guard subcommand", () => {
    // direct CLI oracle invocations
    expect(
      classifyCommand(
        'node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard "find packages/app/dist -delete"'
      )
    ).toBe("deny")
    expect(
      classifyCommand(
        'node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard "rm -r dist"'
      )
    ).toBe("deny")
    expect(classifyCommand('pnpm harness guard "rm -r dist"')).toBe("deny")
    expect(classifyCommand('pnpm run harness guard "ls"')).toBe("deny")
    expect(classifyCommand("CI=true pnpm harness guard --format=antigravity")).toBe("deny")
    // flags / '--' before 'guard' (review F-03)
    expect(classifyCommand('pnpm harness -- guard "rm -r dist"')).toBe("deny")
    expect(
      classifyCommand(
        'node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts --format=antigravity guard "rm -r dist"'
      )
    ).toBe("deny")
  })

  it("REQ-2.2 keeps the other harness-cli subcommands allowed", () => {
    for (const sub of ["plan-check", "verify", "done", "gc --strict", "route", "report", "session", "doctor", "ontology check"]) {
      expect(classifyCommand(`pnpm harness ${sub}`)).toBe("allow")
      expect(
        classifyCommand(`node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ${sub}`)
      ).toBe("allow")
    }
    expect(classifyCommand("git grep -n guardrail -- libs")).toBe("allow")
    // 'harness guard' inside commit message / log grep (review F-04)
    expect(classifyCommand("git commit -m 'fix: harden harness guard policy'")).toBe("allow")
    expect(classifyCommand('git log --grep="harness guard" -n 5')).toBe("allow")
  })

  // harness:SPEC-0001 · 3 — secret-file tokens and obfuscation
  it("REQ-3.1 denies dotenv files referenced as path tokens", () => {
    expect(classifyCommand("cat .env")).toBe("deny")
    expect(classifyCommand("cat ./.env")).toBe("deny")
    expect(classifyCommand("cat .env.local")).toBe("deny")
    expect(classifyCommand("head -n 3 config/.env.production")).toBe("deny")
    expect(classifyCommand("cp .env.example .env")).toBe("deny")
    expect(classifyCommand("grep TOKEN '.env'")).toBe("deny")
    // globs, multi-dot suffixes, backslash / empty-quote escapes (review F-05, F-07)
    expect(classifyCommand("cat .env*")).toBe("deny")
    expect(classifyCommand("cat .env.development.local")).toBe("deny")
    expect(classifyCommand("head -n 3 config/.env.production.local")).toBe("deny")
    expect(classifyCommand("cat \\.env")).toBe("deny")
    expect(classifyCommand("cat .''env")).toBe("deny")
    expect(classifyCommand('cat .e""nv')).toBe("deny")
  })

  it("REQ-3.2 does not deny env identifiers or dotenv templates", () => {
    // env identifiers and template files
    expect(classifyCommand('git grep -n "process.env" -- src/config')).toBe("allow")
    expect(classifyCommand('git grep -c "process.env" -- src/cli')).toBe("allow")
    expect(classifyCommand("git grep -n import.meta.env -- apps")).toBe("allow")
    expect(classifyCommand("cat .env.example")).toBe("allow")
    expect(classifyCommand("cat .env.template")).toBe("allow")
    expect(classifyCommand("cat apps/sample/.env.sample")).toBe("allow")
    expect(classifyCommand("cat .env.development.example")).toBe("allow")
    // '.env' inside commit messages or grep patterns (review F-08)
    expect(classifyCommand("git commit -m 'chore: add .env to .gitignore'")).toBe("allow")
    expect(classifyCommand("git grep '\\.env' -- libs")).toBe("allow")
  })

  it("REQ-3.3 escalates words split by single-character classes or empty quotes", () => {
    // single-char bracket and empty-quote obfuscation
    expect(classifyCommand('git grep -n "process\\.[e]nv" -- src/config')).toBe("escalate")
    expect(classifyCommand("git grep -n \"process\\['e[n]v'\\]\" -- src/cli")).toBe("escalate")
    expect(classifyCommand('git grep -n "\\<e[n]v\\>" -- src/cli')).toBe("escalate")
    expect(classifyCommand("cat .[e]nv")).toBe("escalate")
    expect(classifyCommand("cat [.]env")).toBe("escalate")
    expect(classifyCommand("r''m -r dist")).toBe("escalate")
    // a multi-character class is a normal regex, not obfuscation
    expect(classifyCommand('git grep -n "[A-Z_]+" -- libs')).toBe("allow")
  })
})
