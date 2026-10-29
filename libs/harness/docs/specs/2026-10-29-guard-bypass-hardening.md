---
id: harness:SPEC-0001
title: Guard bypass hardening (destructive arguments, self-invocation, secret-path tokens, obfuscation)
status: accepted
archetype: framework
date: 2026-10-29
enforced_by:
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/test/policy.test.ts
  - libs/harness/decision/src/guard-decision.ts
spans:
  - Harness.decideGuardCommand
---

# harness:SPEC-0001: Guard bypass hardening

## Context

Live exploratory audit (2026-10-29, findings F1–F4) showed the
`PreToolUse` guard working as designed: clef (`GuardV1` via `Harness.decideGuardCommand`) denied `rm -r dist …` with
destructive = 0.81. Right after that, the agent deleted the same directories with `find <dir> -depth -delete`, and
the guard allowed it. `classifyCommand` checks `ALLOWLIST` by **prefix**, so any `find …` is allowed deterministically
and never reaches clef. Before switching, the agent called the guard CLI directly
(`node … apps/harness-cli/src/index.ts guard "<cmd>"`) to find out which variant would pass. That CLI is allowed
through the `node --import … harness-cli` prefix. In the same session the `DENYLIST` token `.env` (plain substring)
denied the harmless `grep "process\.env"`. The agent got past it with `process\.[e]nv` and `e[n]v`, which shows that
substring rules can be beaten by trivial obfuscation.

- **Reused contracts / functions:** `classifyCommand`, `isCommandAllowed`, `ALLOWLIST`, `DENYLIST`, `ASKLIST`, `SHELL_OPERATORS` (`libs/harness/gates/src/policy.ts`); `GuardV1` and `Harness.decideGuardCommand` (`libs/harness/decision/src/guard-decision.ts`), which already return `ask` when clef is unavailable.
- **Reused services:** none. `classifyCommand` stays a pure, synchronous, deterministic function (ADR-0001: deterministic gates veto, clef only advises).
- **New capabilities needed:** destructive-argument detection that runs **before** allowlist matching; detection of guard self-invocation; a `.env` rule that matches path tokens instead of substrings; an obfuscation heuristic that escalates to clef.

## Goal

An agent cannot get past the guard by switching to a different binary, flag or spelling for the same destructive or secret-reading action, and it cannot use the guard itself to test candidate commands. Harmless read-only commands that mention `env` in identifiers are no longer denied.

## How to read the requirements

Requirements follow EARS syntax. Each requirement is one sentence with bold keywords (`When`, `While`, `If … then`, `Where`) and the modal `shall` or `shall not`. "Escalate" means `classifyCommand` returns `"escalate"`, so `Harness.decideGuardCommand` asks clef and falls back to `ask` (never `allow`).

## Requirements

### 1 · Destructive arguments on allowlisted binaries

**Source (live audit 2026-10-29, finding F1):** `find … -depth -delete` was allowed deterministically right after clef denied `rm -r`.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Unwanted behaviour | **If** a command contains a find action that deletes or executes (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`), including quoted flag tokens, **then** the classifyCommand guard policy **shall** return escalate. | Harness.decideGuardCommand | test |
| REQ-1.2 | Unwanted behaviour | **If** a command discards git state (`git checkout` or `git restore` with `--`, `.` or `-f`, `git stash drop`, `git stash clear`, `git branch -D`, `git branch -d`, `git branch --delete`, `git clean`, `git switch --discard-changes`, `git switch -f`, `git reset --hard`), **then** the classifyCommand guard policy **shall** return ask. | Harness.decideGuardCommand | test |
| REQ-1.3 | Unwanted behaviour | **If** a command redirects output into a file with unquoted `>`, `>>`, `&>` or `>&`, **then** the classifyCommand guard policy **shall** return escalate. | Harness.decideGuardCommand | test |
| REQ-1.4 | Unwanted behaviour | **If** the first segment of a piped command matches REQ-1.1, REQ-1.2 or REQ-1.3, **then** the classifyCommand guard policy **shall** return the corresponding escalate or ask verdict instead of applying the read-only pipe allowance. | Harness.decideGuardCommand | test |
| REQ-1.5 | Ubiquitous | The classifyCommand guard policy **shall** keep returning allow for read-only find invocations, for `git checkout -b`, for redirections to `/dev/null` or stream duplication such as `2>&1`, and when `>` or `-delete` appears only inside a quoted string or `git commit -m` / `git grep` data argument. | Harness.decideGuardCommand | test |

### 2 · Guard self-invocation

**Source (live audit 2026-10-29, finding F2):** the agent tested candidate commands against the guard CLI before running them.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-2.1 | Unwanted behaviour | **If** a command invokes the harness guard subcommand (`harness guard`, `harness -- guard`, `harness run guard`, `apps/harness-cli/src/index.ts [flags] guard`), **then** the classifyCommand guard policy **shall** return deny. | Harness.decideGuardCommand | test |
| REQ-2.2 | Ubiquitous | The classifyCommand guard policy **shall** keep returning allow for the other harness-cli subcommands (`plan-check`, `verify`, `done`, `gc`, `route`, `report`, `session`, `doctor`, `ontology`) and when `harness guard` appears inside a `git commit -m` or `git log --grep` argument. | Harness.decideGuardCommand | test |

### 3 · Secret-file tokens and obfuscation

**Source (live audits 2026-10-28 and 2026-10-29, findings F3 and F4):** `process.env` greps were denied, and bracket obfuscation got past the deny.

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-3.1 | Unwanted behaviour | **If** a command references a dotenv file as a path token (`.env`, `./.env`, `.env*`, `.env.local`, `.env.development.local`, `config/.env.production`, or quote/backslash-escaped `.e""nv` / `\.env`), **then** the classifyCommand guard policy **shall** return deny. | Harness.decideGuardCommand | test |
| REQ-3.2 | Ubiquitous | The classifyCommand guard policy **shall not** deny a command in which `env` appears only inside an identifier such as `process.env` or `import.meta.env`, inside a `git commit -m` / `git grep` pattern argument, or as the template files `.env.example`, `.env.template`, `.env.sample` (including multi-dot `.env.development.example`). | Harness.decideGuardCommand | test |
| REQ-3.3 | Unwanted behaviour | **If** a command splits a word with a single-character bracket class (`[e]nv`, `e[n]v`, `[.]env`) or with empty quotes (`r''m`), **then** the classifyCommand guard policy **shall** return escalate. | Harness.decideGuardCommand | test |

## Assumptions

* **REQ-1.1, REQ-1.3, REQ-1.4, REQ-3.3:** escalate, not deny. Some of these are legitimate (e.g. `find dist -delete` in a clean-up task). clef and the human `ask` fallback decide; deterministic rules only take away the automatic `allow`.
* **REQ-1.2:** ask, not escalate. Losing uncommitted git work can't be undone, and clef underrates it (`git checkout -- .` scored destructive = 0.26, which would mean `allow`). A human always confirms.
* **REQ-1.3:** stream duplication (`2>&1`, `>&2`) and `/dev/null` targets are not file writes.
* **REQ-2.1:** deny is safe because the IDE calls hooks directly, not through an agent shell command. Humans can still run `harness guard` in their own terminal, which is not guarded.
* **REQ-3.1:** `cp .env.example .env` is denied because its second token writes `.env`. This matches the intent of the existing `.env` rule.

### clef evidence (GuardV1 on `clef-flash`, 2026-10-29)

| Command (newly escalated) | destructive | secretAccess | Verdict |
| --- | --- | --- | --- |
| `find packages/foo/dist -depth -delete` | 0.91 | 0.01 | deny |
| `find . -name '*.log' -exec rm {} +` | 0.80 | 0.01 | deny |
| `find libs -name '*.ts' -exec grep -l Effect {} +` | 0.01 | 0.01 | allow |
| `git checkout -- .` | **0.26** | 0.02 | **allow** → hence REQ-1.2 = ask |
| `git stash drop` / `git branch -D x` / `git reset --hard HEAD~1` | 0.82 / 0.77 / 0.87 | ≤ 0.01 | deny |
| `cat package.json > /tmp/out.json` | 0.07 | 0.07 | allow |
| `git grep -n "process\.[e]nv" -- src` | 0.01 | 0.45 | ask |
| `cat .[e]nv` | 0.01 | **0.92** | deny |

## Out of scope

* **Session id in telemetry and a `done` exemption for sessions without edits (F5, F6).** Decides: next harness task.
* **clef warm-up cost and `keep_alive` (F7).** Decides: next harness task.
* **`engineSource` / `detail` on CLI guard and route telemetry.** Decides: next harness task.
* **A full shell parser.** Rules stay regex-based. Anything the regexes don't cover still escalates through `SHELL_OPERATORS` or the allowlist miss.

## Known residual risks

* Regex rules can still be beaten by spellings the heuristics don't cover (e.g. `$(printf …)` command substitution, variables holding command names). Those forms don't match `ALLOWLIST`, so they escalate to clef, and the fallback is still `ask`, never `allow`.
* `-exec grep …` inside `find` now escalates even though it is read-only. That costs one clef call (about 100 ms warm) and maybe an `ask`.

## Acceptance criteria

* Every REQ row has a passing case in `libs/harness/gates/test/policy.test.ts`. Existing cases keep passing, except `cat .env` and similar, which stay `deny`.
* `harness plan-check`, `harness gc --strict` and `harness verify` are green.
* Frontmatter changes to `status: accepted` once implemented.

## Implementation plan

1. **Tests first (`policy.test.ts`):** one `it` block per area, each REQ with positive and negative cases.
2. **`policy.ts`:**
   - Add exported rule tables: `DESTRUCTIVE_ARGUMENT_PATTERNS`, `GUARD_SELF_INVOCATION_PATTERN`, `SECRET_FILE_PATTERN`, `OBFUSCATION_PATTERNS`.
   - Remove the `.env` substring token from `DENYLIST`.
   - New order inside `classifyCommand`: deny (DENYLIST, secret path, self-invocation) → ask (ASKLIST) → escalate (destructive arguments, obfuscation) → shell operators / pipe allowance → allowlist.
   - The signature stays the same. No new Effect spans or services, so a `stub` skeleton does not apply. `plan-check` still runs to snapshot the plan graph that `done` requires.
3. **Docs:** guard section in `docs/architecture-and-workflow.md`.
4. **ADR `harness:ADR-0003`:** "Guard deterministic layer removes automatic allow, never adds deny for ambiguous forms". It records why destructive-argument and obfuscation rules escalate instead of deny, and why the allowlist must stay after them. This passes the counterfactual test: a future agent "simplifying" the order would reopen F1.
5. **Gates:** `plan-check` → `gc --strict` → `verify` → `done`.
