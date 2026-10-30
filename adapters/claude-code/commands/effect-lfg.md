---
name: effect-lfg
description: Use when the user asks for autonomous end-to-end execution of a requirement, feature, bugfix, or EARS spec through the full Effect-TS Engineering Harness without stopping between stages, or when invoking /effect-lfg directly.
argument-hint: "[requirement, bug report, EARS spec path, or PR/review reference]"
---

Invoke and follow the `effect-lfg` skill (`adapters/claude-code/skills/effect-lfg/SKILL.md`) to execute `$ARGUMENTS` autonomously from start to finish through the Effect-TS Engineering Harness pipeline (Stage 0 Worktree Readiness $\rightarrow$ Stage 1 Autonomous EARS Spec $\rightarrow$ Stage 2 Plan-as-Code `stub<A, E, R>()` & `harness plan-check` $\rightarrow$ Stage 3 Package-Isolated `flash` Implementation $\rightarrow$ Stage 4 4-Lens Specialist Review & Auto-Fix $\rightarrow$ Stage 5 `harness learn` & Final Deterministic Gates `gc --strict` / `ontology check --strict` / `mutate --strict` / `verify` / `done` $\rightarrow$ Stage 6 Git Commit, Optional Push/PR & `<promise>DONE</promise>`).
