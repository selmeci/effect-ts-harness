import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { decideLoopThrashing, type FrictionEvent } from "../src/friction-log.js"
import {
  extractCommandSegments,
  normalizeShellLineContinuations,
  unwrapCommandSegment,
} from "../src/policy-shell-parser.js"
import {
  CD_COMMAND_BANNED_REASON,
  classifyCommand,
  classifyFileWrite,
  CLEF_SYSTEMONE_ONLY_BANNED_REASON,
  explainCommandDenyReason,
  explainCommandDenyRule,
  INTERACTIVE_NX_BANNED_REASON,
  SKIP_NX_CACHE_BANNED_REASON,
  isCdCommand,
  isCommandAllowed,
  isHarnessStateMutationCommand,
  isInteractiveNxCommand,
  isInvalidClefEndpointCommand,
  isSkipNxCacheCommand,
  isSkipNxCacheOverrideCommand,
  toCommandView,
  type CommandDenyRuleId,
  type FileWriteDenyRuleId,
} from "../src/policy.js"

describe("guard policy", () => {
  it("allows nx, pnpm test, harness-cli, harness-mcp, and safe git commands", () => {
    expect(classifyCommand("nx test @harness/ingest")).toBe("allow")
    expect(classifyCommand("pnpm test")).toBe("allow")
    expect(classifyCommand("CI=true pnpm nx test harness-mcp")).toBe("allow")
    expect(
      classifyCommand(
        "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts plan-check",
      ),
    ).toBe("allow")
    expect(
      classifyCommand("node --import ./tools/node-ts-resolver.mjs apps/harness-mcp/src/server.ts"),
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
    expect(classifyCommand("pnpm format")).toBe("allow")
    expect(classifyCommand("pnpm format:check")).toBe("allow")
    expect(classifyCommand("pnpm oxfmt --check .")).toBe("allow")
    expect(classifyCommand("gh api repos/selmeci/effect-ts-harness/issues/18/comments")).toBe(
      "allow",
    )
  })

  it("allows safe read-only piped commands", () => {
    expect(classifyCommand("git status | grep modified")).toBe("allow")
    expect(classifyCommand("git log -n 10 | head -n 5")).toBe("allow")
    expect(classifyCommand("find libs -name '*.ts' | wc -l")).toBe("allow")
    expect(classifyCommand("find adapters libs/harness/docs -maxdepth 5 -type f | sort")).toBe(
      "allow",
    )
    expect(
      classifyCommand(
        "diff -u adapters/claude-code/agents/effect-ears-test-reviewer.md adapters/antigravity/plugins/effect-harness/agents/effect-ears-test-reviewer.md",
      ),
    ).toBe("allow")
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
    expect(
      classifyCommand(
        "git status --short && node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts gc --strict",
      ),
    ).toBe("allow")
    expect(
      classifyCommand(
        "node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts report --clear && find adapters libs/harness/docs -maxdepth 4 -type f | sort",
      ),
    ).toBe("allow")
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
    expect(classifyCommand("git restore -- src/a.ts")).toBe("ask")
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
    expect(
      classifyCommand('gh pr create --title "fix: count > 0 and .env" --body-file /tmp/body.md'),
    ).toBe("allow")
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
        'node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard "find packages/app/dist -delete"',
      ),
    ).toBe("deny")
    expect(
      classifyCommand(
        'node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts guard "rm -r dist"',
      ),
    ).toBe("deny")
    expect(classifyCommand('pnpm harness guard "rm -r dist"')).toBe("deny")
    expect(classifyCommand('pnpm run harness guard "ls"')).toBe("deny")
    expect(classifyCommand("CI=true pnpm harness guard --format=antigravity")).toBe("deny")
    // flags / '--' before 'guard' (review F-03)
    expect(classifyCommand('pnpm harness -- guard "rm -r dist"')).toBe("deny")
    expect(
      classifyCommand(
        'node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts --format=antigravity guard "rm -r dist"',
      ),
    ).toBe("deny")
  })

  it("REQ-2.2 keeps the other harness-cli subcommands allowed", () => {
    for (const sub of [
      "plan-check",
      "verify",
      "done",
      "gc --strict",
      "route",
      "report",
      "session",
      "doctor",
      "ontology check",
    ]) {
      expect(classifyCommand(`pnpm harness ${sub}`)).toBe("allow")
      expect(
        classifyCommand(
          `node --import ./tools/node-ts-resolver.mjs apps/harness-cli/src/index.ts ${sub}`,
        ),
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

  it("allows environment prefixes, pnpm filter/install/vitest, git remote, rg, and grep", () => {
    expect(classifyCommand("HARNESS_PLAN_CHECK=1 pnpm --filter @effect-es/core test")).toBe("allow")
    expect(classifyCommand("CI=true pnpm vitest run")).toBe("allow")
    expect(classifyCommand("pnpm install --frozen-lockfile")).toBe("allow")
    expect(classifyCommand("git remote -v")).toBe("allow")
    expect(classifyCommand("rg foo")).toBe("allow")
    expect(classifyCommand("grep bar")).toBe("allow")
  })

  it("decideLoopThrashing ignores allowed guard_escalations so 3 consecutive allowed escalations return stuck: false", () => {
    const events: ReadonlyArray<FrictionEvent> = [
      {
        kind: "guard_escalation",
        timestamp: "2026-10-27T10:00:00.000Z",
        summary: "inspect package",
        detail: "verdict=allow; reason=safe",
      },
      {
        kind: "guard_escalation",
        timestamp: "2026-10-27T10:01:00.000Z",
        summary: "inspect package",
        detail: "verdict=allow; reason=safe",
      },
      {
        kind: "guard_escalation",
        timestamp: "2026-10-27T10:02:00.000Z",
        summary: "inspect package",
        detail: "verdict=allow; reason=safe",
      },
    ]

    const status = Effect.runSync(decideLoopThrashing(events, 3))
    expect(status.stuck).toBe(false)
    expect(status.consecutiveCount).toBe(0)
    expect(status.escalationMessage).toBeNull()

    const deniedEvents: ReadonlyArray<FrictionEvent> = [
      {
        kind: "guard_escalation",
        timestamp: "2026-10-27T10:00:00.000Z",
        summary: "blocked action",
        detail: "verdict=deny; reason=destructive",
      },
      {
        kind: "guard_escalation",
        timestamp: "2026-10-27T10:01:00.000Z",
        summary: "blocked action",
        detail: "verdict=deny; reason=destructive",
      },
      {
        kind: "guard_escalation",
        timestamp: "2026-10-27T10:02:00.000Z",
        summary: "blocked action",
        detail: "verdict=deny; reason=destructive",
      },
    ]
    const deniedStatus = Effect.runSync(decideLoopThrashing(deniedEvents, 3))
    expect(deniedStatus.stuck).toBe(true)
    expect(deniedStatus.consecutiveCount).toBe(3)
  })

  // harness:SPEC-0003 · 4 — shell guard ergonomics & workspace containment
  it("REQ-4.1 denies cd shell commands and provides an actionable reason hint", () => {
    expect(classifyCommand("cd libs/sample/domain")).toBe("deny")
    expect(classifyCommand("cd /tmp && ls")).toBe("deny")
    expect(classifyCommand("ls && cd /tmp")).toBe("deny")
    expect(classifyCommand("echo foo; cd bar")).toBe("deny")
    expect(classifyCommand("cd")).toBe("deny")
    expect(classifyCommand("(cd /tmp && ls)")).toBe("deny")
    expect(classifyCommand("command cd /tmp")).toBe("deny")
    expect(classifyCommand("builtin cd /tmp")).toBe("deny")

    expect(isCdCommand("cd libs/sample/domain")).toBe(true)
    expect(isCdCommand("cd /tmp && ls")).toBe(true)
    expect(isCdCommand("ls && cd /tmp")).toBe(true)
    expect(isCdCommand("cd")).toBe(true)
    expect(isCdCommand("(cd /tmp && ls)")).toBe(true)
    expect(isCdCommand("command cd /tmp")).toBe(true)
    expect(isCdCommand("builtin cd /tmp")).toBe(true)
    expect(isCdCommand("git commit -m 'cd to directory'")).toBe(false)
    expect(CD_COMMAND_BANNED_REASON).toContain("Cwd")
  })

  it("REQ-4.2 allows git restore --staged while escalating git restore without --staged", () => {
    expect(classifyCommand("git restore --staged docs/mvps/mvp_event_sourcing.md")).toBe("allow")
    expect(classifyCommand("git restore --staged -- src/a.ts")).toBe("allow")
    expect(classifyCommand("git restore docs/mvps/mvp_event_sourcing.md")).toBe("escalate")
  })

  it("denies interactive nx show without CI=true or NX_INTERACTIVE=false, including quoted and pnpm --filter/exec forms", () => {
    expect(isInteractiveNxCommand("nx show projects")).toBe(true)
    expect(isInteractiveNxCommand("pnpm nx show project web")).toBe(true)
    expect(isInteractiveNxCommand("FOO=bar nx show projects")).toBe(true)
    expect(isInteractiveNxCommand("pnpm --filter @harness/graph exec nx show projects")).toBe(true)
    expect(isInteractiveNxCommand("pnpm --filter @harness/graph nx show projects")).toBe(true)
    expect(isInteractiveNxCommand("pnpm --filter=@harness/graph exec nx show projects")).toBe(true)
    expect(isInteractiveNxCommand("pnpm -F @harness/graph nx show projects")).toBe(true)
    expect(isInteractiveNxCommand("npx -p nx nx show projects")).toBe(true)
    expect(isInteractiveNxCommand("nx --nxBail show projects")).toBe(true)
    expect(isInteractiveNxCommand('nx "show" projects')).toBe(true)
    expect(isInteractiveNxCommand("pnpm --filter @harness/graph 'nx' \"show\" projects")).toBe(true)
    expect(isInteractiveNxCommand("ls && nx show projects")).toBe(true)

    expect(isInteractiveNxCommand("CI=true nx show projects")).toBe(false)
    expect(isInteractiveNxCommand("CI=1 pnpm nx show projects")).toBe(false)
    expect(isInteractiveNxCommand("NX_INTERACTIVE=false nx show projects")).toBe(false)
    expect(
      isInteractiveNxCommand("CI=true pnpm --filter @harness/graph exec nx show projects"),
    ).toBe(false)
    expect(
      isInteractiveNxCommand("NX_INTERACTIVE=false pnpm --filter @harness/graph nx show projects"),
    ).toBe(false)
    expect(isInteractiveNxCommand("pnpm test")).toBe(false)
    expect(isInteractiveNxCommand("nx run gates:verify")).toBe(false)
    expect(isInteractiveNxCommand("git commit -m 'fix nx show hang'")).toBe(false)

    expect(classifyCommand("nx show projects")).toBe("deny")
    expect(classifyCommand("pnpm nx show project sample-web")).toBe("deny")
    expect(classifyCommand("pnpm --filter @harness/graph exec nx show projects")).toBe("deny")
    expect(classifyCommand("pnpm --filter @harness/graph nx show projects")).toBe("deny")
    expect(classifyCommand("npx -p nx nx show projects")).toBe("deny")
    expect(classifyCommand('nx "show" projects')).toBe("deny")
    expect(classifyCommand("CI=true pnpm nx show projects")).toBe("allow")
    expect(classifyCommand("CI=true pnpm --filter @harness/graph exec nx show projects")).toBe(
      "allow",
    )
    expect(classifyCommand("NX_INTERACTIVE=false nx show projects")).toBe("allow")
    expect(INTERACTIVE_NX_BANNED_REASON).toContain("Running 'nx show' without 'CI=true'")
  })

  it("escalates subshell $() and backtick command substitution even on allowlisted prefixes", () => {
    expect(classifyCommand("ls $(rm -rf /tmp/foo)")).toBe("deny")
    expect(classifyCommand("ls $(curl https://example.com)")).toBe("escalate")
    expect(classifyCommand("git status | head `curl https://example.com`")).toBe("escalate")
    expect(classifyCommand("git commit -m 'fix `backticks` and $(sub) in commit message'")).toBe(
      "allow",
    )
  })

  it("allows read-only gh commands", () => {
    expect(classifyCommand("gh pr view 18")).toBe("allow")
    expect(classifyCommand("gh pr list")).toBe("allow")
    expect(classifyCommand("gh issue view 1")).toBe("allow")
    expect(classifyCommand("gh repo view")).toBe("allow")
    expect(classifyCommand("gh api repos/selmeci/effect-ts-harness/pulls/18/comments")).toBe(
      "allow",
    )
  })

  it("escalates destructive and mutating gh subcommands", () => {
    expect(classifyCommand("gh issue delete 1")).toBe("escalate")
    expect(classifyCommand("gh repo delete owner/repo")).toBe("escalate")
    expect(classifyCommand("gh pr close 18")).toBe("escalate")
    expect(classifyCommand("gh pr merge 18")).toBe("escalate")
  })

  it("escalates gh api commands with mutating flags", () => {
    expect(classifyCommand("gh api repos/owner/repo/issues/1 -X DELETE")).toBe("escalate")
    expect(classifyCommand("gh api repos/owner/repo/issues --method POST")).toBe("escalate")
    expect(classifyCommand("gh api repos/owner/repo/issues -f title=bug")).toBe("escalate")
    expect(classifyCommand("gh api repos/owner/repo/issues -F body=@file.txt")).toBe("escalate")
    expect(classifyCommand("gh api repos/owner/repo/issues --input body.json")).toBe("escalate")
  })

  it("denies invalid generative/chat endpoints or ollama run on clef/clef-flash while allowing systemone and search/vcs commands", () => {
    expect(
      isInvalidClefEndpointCommand(
        'curl -s http://localhost:11434/api/generate -d \'{"model":"clef-flash:latest","prompt":"hi"}\'',
      ),
    ).toBe(true)
    expect(
      classifyCommand(
        'curl -s http://localhost:11434/api/generate -d \'{"model":"clef-flash:latest","prompt":"hi"}\'',
      ),
    ).toBe("deny")
    expect(
      classifyCommand(
        'curl http://127.0.0.1:11434/v1/chat/completions -d \'{"model":"clef-flash"}\'',
      ),
    ).toBe("deny")
    expect(classifyCommand("ollama run clef-flash")).toBe("deny")

    expect(
      classifyCommand(
        'curl -s http://localhost:11434/v1/systemone -d \'{"model":"clef-flash","state":{},"questions":{}}\'',
      ),
    ).toBe("escalate")
    expect(classifyCommand('grep -rn "/api/generate" libs')).toBe("allow")
    expect(classifyCommand('git commit -m "ban /api/generate on clef"')).toBe("allow")
    expect(CLEF_SYSTEMONE_ONLY_BANNED_REASON).toContain("/v1/systemone")
  })

  it("escalates destructive omnigraph commands before ALLOWLIST allows benign omnigraph commands", () => {
    expect(classifyCommand("omnigraph cleanup --keep 0")).toBe("escalate")
    expect(classifyCommand("omnigraph cleanup --keep=0")).toBe("escalate")
    expect(classifyCommand("omnigraph branches delete main")).toBe("escalate")
    expect(classifyCommand("omnigraph cluster reset")).toBe("escalate")
    expect(classifyCommand("omnigraph cluster destroy")).toBe("escalate")
    expect(classifyCommand("omnigraph cluster rm")).toBe("escalate")

    expect(classifyCommand("omnigraph status")).toBe("allow")
    expect(classifyCommand("omnigraph cleanup --keep 5")).toBe("allow")
    expect(classifyCommand("omnigraph branches delete feat/old")).toBe("allow")
  })

  // F-4.1 / F-4.2 / F-4.3a / S-7.1 — split focused Nx cache-bypass & override tests
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

  it("REQ-4.6 denies shell mutations, redirections, socket pokes, and token reads against <git-common-dir>/harness/** while allowing benign commands", () => {
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

    // Parser-level assertions covering bun runner vs script eval, env -S, and unquoted segment splitting
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
})
