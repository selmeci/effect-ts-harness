---
name: effect-code-review
description: Use when asked to review a git diff, branch, commit range, uncommitted changes, or pull request in an Effect-TS Harness workspace, when auditing behavioral, architectural, or migration risks before opening or merging a PR, or when invoking /effect-code-review directly.
argument-hint: "[git diff range, branch, PR number, or file paths]"
---

Invoke and follow the `effect-code-review` skill (`adapters/claude-code/skills/effect-code-review/SKILL.md`) to perform a strictly read-only, graph-first, signal-routed code review of `$ARGUMENTS` (Stage 1 `harness_review_route` & `harness_lsp_diagnostics` Pre-Pass -> Stage 2 `skip | lite | focused | full` Depth Gate & 7-Specialist Dispatch -> Stage 3 Graph Verification & Hard False-Positive Suppression Gate -> Stage 4 Positive Ordered 4-Section Report Recipe & Read-Only Handoff to `resolving-effect-review-feedback`).
