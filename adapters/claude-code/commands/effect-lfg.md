---
name: effect-lfg
description: Use when the user asks for autonomous end-to-end execution of a requirement, feature, bugfix, EARS spec, or multi-phase RFC through the full Effect-TS Engineering Harness without stopping between stages, or when invoking /effect-lfg directly.
argument-hint: "[requirement, bug report, EARS spec path, RFC path, or PR/review reference]"
---

Invoke and follow the `effect-lfg` skill (`adapters/claude-code/skills/effect-lfg/SKILL.md`) to execute `$ARGUMENTS` autonomously from start to finish through the Effect-TS Engineering Harness pipeline (Stage 0 Worktree Readiness -> Stage 1 Route Intake `B/D/A/C` & Autonomous EARS Spec -> Stage 2 Plan-as-Code `stub<A, E, R>()` & `pnpm harness plan-check` [or Route D Wave-by-Wave Worktree Slices] -> Stage 3 Package-Isolated `flash` Implementation -> Stage 4 Signal-Routed 7-Lens Specialist Review & Auto-Fix -> Stage 5 `pnpm harness learn` & Final Deterministic Gates `gc --strict` / `ontology check --strict` / `mutate --strict` / `verify` / `done` -> Stage 6 Git Commit, Optional Push/PR & `<promise>DONE</promise>`).
