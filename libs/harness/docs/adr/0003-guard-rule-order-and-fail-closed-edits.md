---
id: harness:ADR-0003
title: "Guard rule order: deny → ask → escalate → allowlist, and fail-closed guard edits"
status: accepted
date: 2026-10-29
enforced_by:
  - libs/harness/gates/src/policy.ts
  - libs/harness/gates/test/policy.test.ts
spans:
  - Harness.decideGuardCommand
---

# ADR-0003: Guard rule order — deny → ask → escalate → allowlist

## Context and Problem Statement

`classifyCommand` (`libs/harness/gates/src/policy.ts`) is the deterministic layer of the `PreToolUse` guard. Only commands it returns as `"escalate"` reach clef (`GuardV1` via `Harness.decideGuardCommand`). The `ALLOWLIST` matches by **prefix**, so every rule placed after it is skipped for any command that starts with an allowlisted binary. Live exploratory sessions on 2026-10-29 exposed this: clef denied `rm -r dist …`, and seconds later the agent ran `find dist -depth -delete`. That command starts with `find`, so it was allowed without ever reaching clef. The agent had first tested candidate commands against the guard CLI itself, which is allowed by the `node --import … harness-cli` prefix. In the same session a substring `.env` rule denied `grep "process\.env"`, and bracket obfuscation (`process\.[e]nv`) got past it. If the order and intent of the rules are not written down, a future "simplification" (e.g. checking the allowlist first for speed) reopens all of these holes.

The same session showed a second failure mode. The guard hook imports `policy.ts`, so a syntax error introduced while editing `policy.ts` makes every `PreToolUse` hook crash. The editing agent is then locked out of all writes and shell commands, and only a human can repair the file.

## Decision Drivers

* Deterministic rules hold absolute veto (harness:ADR-0001). clef only advises on what the deterministic layer leaves open, and its fallback is `ask`, never `allow`.
* A rule that takes away an automatic `allow` is useless if a prefix match can grant `allow` before it runs.
* Ambiguous but sometimes legitimate commands (`find dist -delete` in a clean-up task) must not be hard-denied, because that pushes agents to obfuscate.
* Irreversible loss of uncommitted git work must not depend on clef. Probe: `git checkout -- .` scored destructive = 0.26, which means `allow`.
* An agent must be able to recover from its own edit mistakes, except in the guard itself, where failing closed is the safe default.

## Considered Options

* **Option 1:** Ordered stages deny → ask → escalate → allowlist, with escalate (not deny) for ambiguous forms and ask for git discards.
* **Option 2:** Keep the allowlist first and add more denylist tokens (`-delete`, `checkout --`, …).
* **Option 3:** Replace regex rules with a full shell parser and argument-level policy.

## Decision Outcome

**Chosen option:** "Option 1 — ordered stages deny → ask → escalate → allowlist". Binding rules:

1. Stage order in `classifyCommand` is: `DENYLIST` / `SECRET_FILE_PATTERN` / `GUARD_SELF_INVOCATION_PATTERN` → **deny**; `ASKLIST` / `GIT_DISCARD_PATTERNS` → **ask**; `DESTRUCTIVE_ARGUMENT_PATTERNS` / `OBFUSCATION_PATTERNS` → **escalate**; then `SHELL_OPERATORS` and the read-only pipe allowance; the prefix `ALLOWLIST` comes **last**.
2. New rules that take away an automatic `allow` must be added before stage 4 and must escalate, unless the action is irreversible *and* clef has been shown to underrate it. In that case they ask.
3. Secret files are matched as path tokens, never as substrings, so identifiers such as `process.env` stay allowed.
4. Agents may not invoke the `guard` subcommand. Only the IDE hook calls it.
5. Edits to `libs/harness/gates/src/policy.ts` are made as **one complete write** after the new rules pass their tests. Partial in-place edits are avoided, because a broken file locks the agent out (fail-closed).

## Rejected Alternatives

### 1 · Allowlist first with more denylist tokens

**Why rejected:** Every new spelling (`-delete`, `-exec rm`, `-execdir`, `xargs rm`, `git restore .`) needs its own token, and the allowlist still grants `allow` to anything a token misses. Hard denies also push agents to obfuscate, as already seen with `.env`.

### 2 · Full shell parser

**Why rejected:** It is a large new dependency and attack surface for a pre-tool hook with a 10 s budget. Anything the regex stages miss already falls through to `escalate` (allowlist miss or shell operator), so clef plus the `ask` fallback covers the gap without a parser.

## Consequences and Enforcement

### Positive Consequences

* `find … -delete`, `-exec rm`, file redirection and obfuscated words always reach clef. Probes on 2026-10-29: `find -delete` scored 0.91 (deny), `-exec rm` 0.80 (deny), `cat .[e]nv` secretAccess 0.92 (deny).
* Harmless `process.env` greps are no longer denied, so agents have no reason to obfuscate.
* The guard can't be used as an oracle to search for bypasses.

### Negative Consequences and Trade-offs

* Read-only `find … -exec grep` and `cat a > /tmp/b` now cost one clef call (about 100 ms warm). clef allows both.
* Discarding git work always needs a human click, even when it is intended.
* A broken `policy.ts` still locks the agent out until a human repairs it. This is accepted as fail-closed; rule 5 lowers the chance.

### Deterministic Enforcement

| Rule | Enforced By | Gate / Mechanism | Governed Symbols |
| :--- | :--- | :--- | :--- |
| Stage order deny → ask → escalate → allowlist | `libs/harness/gates/src/policy.ts` | `classifyCommand` + `libs/harness/gates/test/policy.test.ts` (REQ-1.4 pipe case, REQ-1.1 `find -delete`) | `Harness.decideGuardCommand` |
| Git discards ask, never escalate | `libs/harness/gates/src/policy.ts` | `GIT_DISCARD_PATTERNS` + policy tests REQ-1.2 | `Harness.decideGuardCommand` |
| Secret files as path tokens only | `libs/harness/gates/src/policy.ts` | `SECRET_FILE_PATTERN` + policy tests REQ-3.1 / REQ-3.2 | `Harness.decideGuardCommand` |
| No agent-initiated guard calls | `libs/harness/gates/src/policy.ts` | `GUARD_SELF_INVOCATION_PATTERN` + policy tests REQ-2.1 / REQ-2.2 | `Harness.decideGuardCommand` |
| Destructive argument & obfuscation escalation | `libs/harness/gates/src/policy.ts` | `DESTRUCTIVE_ARGUMENT_PATTERNS` + `OBFUSCATION_PATTERNS` + policy tests REQ-1.1 / REQ-1.3 / REQ-3.3 | `Harness.decideGuardCommand` |
