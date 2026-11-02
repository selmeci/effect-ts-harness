# Integrate oxfmt Formatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `oxfmt` (the Rust-based formatter from the OXC family) into the repository as the standard Prettier-compatible code formatter, configuring scripts, configuration, ignores, and Nx caching.

**Architecture:** Install `oxfmt` as a root devDependency alongside existing `oxlint` tooling. Establish a root `.oxfmtrc.json` matching the repository's formatting conventions (semicolon-free, double quotes, 2 spaces, ignoring git subtrees `repos/**` and build artifacts). Expose root `format` and `format:check` scripts, wire `.oxfmtrc.json` into Nx shared globals, and ensure guard policy allowlists format commands.

**Tech Stack:** `oxfmt` (v0.75.0), Node.js (>=24), pnpm (v12), Nx (23.2.1), git.

**Spec:** Integration brief derived from user request `/goal V ramci noveho worktree si napis plan ako integrovat oxfmt do projektu. Nasledne tento plan realizuj a priprav PR.`

## Global Constraints

- `repos/effect` and `repos/alchemy` are read-only squashed git subtrees; `oxfmt` MUST ignore `repos/**` and NEVER format or modify files under `repos/`.
- Codebase style convention: `semi: false`, `singleQuote: false`, `tabWidth: 2`, `useTabs: false`, `bracketSpacing: true`.
- Zero-`any` and minimal-`never` type safety rules remain intact; formatting must not introduce syntax or lint violations in `oxlint`.
- All 14 Nx projects must pass `verify` (`tsc`, `oxlint`, `vitest`, `openapi:check`).

## Review Focus

- Ensure `oxfmt` does not attempt to parse non-standard templated YAML files in `repos/` (e.g. Helm templates in alchemy).
- Verify that formatting changes do not break multiline type annotations, tagged unions, or branded type definitions.
- Ensure `format:check` runs clean in CI and returns exit code 0 when all files are formatted.
- Ensure `pnpm format` and `pnpm oxfmt` commands are permitted in guard policy `ALLOWLIST`.
- Ensure clean Git diff and proper commit format following repo conventions.

---

### Task 1: Package and Configuration Setup

**Files:**

- Modify: `package.json`
- Create: `.oxfmtrc.json`
- Modify: `nx.json`
- Modify: `libs/harness/gates/src/policy.ts`
- Test: `libs/harness/gates/test/policy.test.ts`

**Interfaces:**

- Produces: `format` and `format:check` scripts in root `package.json`.
- Produces: `.oxfmtrc.json` with ignore patterns and format options.

- [ ] **Step 1: Install `oxfmt` in devDependencies**
      Add `oxfmt: "0.75.0"` to root `devDependencies` using `pnpm add -D oxfmt@0.75.0`.

- [ ] **Step 2: Add scripts to `package.json`**
      Add `"format": "oxfmt --write ."` and `"format:check": "oxfmt --check ."` to `package.json` `scripts`.

- [ ] **Step 3: Author `.oxfmtrc.json`**
      Create `.oxfmtrc.json` with:

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "semi": false,
  "singleQuote": false,
  "trailingComma": "all",
  "bracketSpacing": true,
  "arrowParens": "always",
  "ignorePatterns": [
    "repos/**",
    "node_modules/**",
    "dist/**",
    "coverage/**",
    ".worktrees/**",
    ".harness/**",
    ".idea/**",
    "pnpm-lock.yaml"
  ]
}
```

- [ ] **Step 4: Update `nx.json` sharedGlobals**
      Add `"{workspaceRoot}/.oxfmtrc.json"` to `namedInputs.sharedGlobals` in `nx.json`.

- [ ] **Step 5: Update `policy.ts` ALLOWLIST and write unit test**
      Add `"pnpm format"`, `"pnpm oxfmt"`, `"CI=true pnpm format"`, `"CI=true pnpm oxfmt"` to `ALLOWLIST` in `libs/harness/gates/src/policy.ts`. Verify with `pnpm --filter @harness/gates test`.

- [ ] **Step 6: Commit Task 1**
      Commit configuration files and policy changes.

---

### Task 2: Workspace Formatting & Verification

**Files:**

- Modify: Workspace source files requiring formatting (under `apps/`, `libs/`, `tools/`, `scenarios/`, `docs/`)

- [ ] **Step 1: Run `pnpm format`**
      Run `pnpm format` to format the workspace files in place.

- [ ] **Step 2: Run `pnpm format:check`**
      Verify `pnpm format:check` exits with 0 and reports all checked files are formatted.

- [ ] **Step 3: Run `pnpm lint`**
      Verify `pnpm lint` (`oxlint --deny-warnings .`) passes with 0 errors and 0 warnings.

- [ ] **Step 4: Run `CI=true pnpm verify:all`**
      Verify `CI=true pnpm verify:all` passes across all 14 projects.

- [ ] **Step 5: Commit Task 2**
      Commit formatted workspace files.

---

### Task 3: PR Preparation & Final Audit

**Files:**

- Git refs: `feat/integrate-oxfmt` on `origin`

- [ ] **Step 1: Check `git status` and `git diff`**
      Verify working directory is clean and no stray files or subtree modifications exist.

- [ ] **Step 2: Push branch to remote**
      Push `feat/integrate-oxfmt` to `origin`.

- [ ] **Step 3: Open Pull Request using `gh pr create`**
      Create the Pull Request with clear title, summary, test evidence, and review instructions.
