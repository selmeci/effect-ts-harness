import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { match } from "ts-pattern"
import {
  classifyCommand,
  classifyFileRead,
  classifyFileWrite,
  isCommandAllowed,
} from "../src/index.js"

const ReadAndWriteProtectedShellTargetSchema = Schema.Literals([
  ".git/harness/daemon.sock",
  ".git/harness/auth-tokens.json",
  ".git/harness/daemon.lock",
  ".harness/workflow-backups/run-1.json",
  ".harness/omnigraph-cluster/auth-tokens.json",
  ".env",
  ".env.local",
  ".dev.vars",
  "mutation-hmac-v1.key",
])

const WriteProtectedShellTargetSchema = Schema.Literals([
  ".harness/verify-stamp.json",
  ".harness/mutate-stamp.json",
  ".harness/cache/mutation-cache-v1.json",
  "repos/effect/package.json",
])

const QuoteWrapKindSchema = Schema.Literals([
  "raw",
  "single",
  "double",
  "line-continuation",
  "backslash-escape",
  "nested-double-single",
])

const ShellWrapperKindSchema = Schema.Literals([
  "direct",
  "env",
  "timeout",
  "xargs",
  "sh-c",
  "bash-lc",
  "subshell",
  "var-assign",
])

const AllShellVerbSchema = Schema.Literals(["cat", "head", "rm", "cp", "sed"])
const MutatingShellVerbSchema = Schema.Literals(["rm", "cp", "mv", "sed-i", "tee", "redirect"])

const PathObfuscationKindSchema = Schema.Literals([
  "raw",
  "dot-slash",
  "parent-traversal",
  "double-slash",
  "backslash-escape",
  "brace-expansion",
  "glob-char-class",
  "nested-worktree-traversal",
])

const ProtectedReadWritePathTargetSchema = Schema.Literals([
  ".git/harness/daemon.sock",
  ".git/harness/auth-tokens.json",
  ".git/harness/daemon.lock",
  ".env",
  ".env.local",
  ".dev.vars",
])

const ProtectedWriteOnlyPathTargetSchema = Schema.Literals([
  ".harness/verify-stamp.json",
  ".harness/mutate-stamp.json",
  ".harness/cache/mutation-cache-v1.json",
  "repos/effect/package.json",
])

const ValidWorktreePrefixSchema = Schema.Literals([
  "",
  ".harness/workflow-worktrees/run-1/unit-a/",
  ".harness/workflow-worktrees/run-2/unit-b/",
])

const BenignModuleSlugSchema = Schema.Literals(["alpha", "beta", "gamma", "delta"])
const BenignCommandKindSchema = Schema.Literals([
  "git-status",
  "git-diff-stat",
  "vitest-run",
  "pnpm-harness-verify",
])

const applyShellQuoteObfuscation = (
  target: string,
  kind: typeof QuoteWrapKindSchema.Type,
): string =>
  match(kind)
    .with("raw", () => target)
    .with("single", () => `'${target}'`)
    .with("double", () => `"${target}"`)
    .with("line-continuation", () => {
      const splitAt = Math.max(1, Math.floor(target.length / 2))
      return `${target.slice(0, splitAt)}\\\n${target.slice(splitAt)}`
    })
    .with("backslash-escape", () =>
      target.replace(/(?=[a-zA-Z0-9])/g, (_ch, idx: number) => (idx % 3 === 1 ? "\\" : "")),
    )
    .with("nested-double-single", () => {
      const splitAt = Math.max(1, Math.floor(target.length / 2))
      return `"${target.slice(0, splitAt)}"'${target.slice(splitAt)}'`
    })
    .exhaustive()

const formatVerbPayload = (
  verb: string,
  arg: string,
): { readonly bin: string; readonly cmd: string } =>
  match(verb)
    .with("cp", () => ({ bin: "cp", cmd: `cp ${arg} /tmp/out` }))
    .with("mv", () => ({ bin: "mv", cmd: `mv /tmp/src ${arg}` }))
    .with("sed-i", () => ({ bin: "sed -i 's/a/b/'", cmd: `sed -i 's/a/b/' ${arg}` }))
    .with("tee", () => ({ bin: "tee", cmd: `printf '{}' | tee ${arg}` }))
    .with("redirect", () => ({ bin: "sh", cmd: `echo '{}' > ${arg}` }))
    .otherwise((v) => ({ bin: v, cmd: `${v} ${arg}` }))

const wrapObfuscatedShellCommand = (
  verb: string,
  arg: string,
  wrapper: typeof ShellWrapperKindSchema.Type,
): string => {
  const { bin, cmd: inner } = formatVerbPayload(verb, arg)
  return match(wrapper)
    .with("direct", () => inner)
    .with("env", () => `env -i ${inner}`)
    .with("timeout", () => `timeout 5 ${inner}`)
    .with("xargs", () => `printf '%s\\n' ${arg} | xargs ${bin}`)
    .with("sh-c", () => `sh -c "${inner.replace(/"/g, '\\"')}"`)
    .with("bash-lc", () => `bash -lc "${inner.replace(/"/g, '\\"')}"`)
    .with("subshell", () => `$(echo ${inner})`)
    .with("var-assign", () => `TARGET=${arg}; ${formatVerbPayload(verb, '"$TARGET"').cmd}`)
    .exhaustive()
}

const obfuscateFilePath = (
  target: string,
  prefix: string,
  kind: typeof PathObfuscationKindSchema.Type,
): string => {
  const base = `${prefix}${target}`
  return match(kind)
    .with("raw", () => base)
    .with("dot-slash", () => `./${base}`)
    .with("parent-traversal", () => `${prefix}sub/../${target}`)
    .with("double-slash", () => base.replace("/", "//"))
    .with("backslash-escape", () => {
      const slash = base.lastIndexOf("/")
      const dir = slash === -1 ? "" : base.slice(0, slash + 1)
      const file = slash === -1 ? base : base.slice(slash + 1)
      const escapedFile = file.length > 2 ? `${file.slice(0, 2)}\\${file.slice(2)}` : `\\${file}`
      return `${dir}${escapedFile}`
    })
    .with("brace-expansion", () => {
      const idx = base.lastIndexOf("/") + 1
      const head = base.slice(0, idx)
      const tail = base.slice(idx)
      return tail.length > 1
        ? `${head}{${tail.slice(0, 1)},x}${tail.slice(1)}`
        : `${head}{${tail},other}`
    })
    .with("glob-char-class", () => {
      const idx = base.lastIndexOf("/") + 1
      const head = base.slice(0, idx)
      const tail = base.slice(idx)
      const ch = tail[1] ?? tail[0] ?? ""
      return /[a-zA-Z0-9]/.test(ch) ? `${head}${tail.slice(0, 1)}[${ch}]${tail.slice(2)}` : base
    })
    .with(
      "nested-worktree-traversal",
      () => `.harness/workflow-worktrees/run-1/unit-a/../../../../../${target}`,
    )
    .exhaustive()
}

const formatBenignCommand = (
  kind: typeof BenignCommandKindSchema.Type,
  slug: typeof BenignModuleSlugSchema.Type,
): string =>
  match(kind)
    .with("git-status", () => "git status")
    .with("git-diff-stat", () => `git diff --stat libs/harness/domain/src/${slug}.ts`)
    .with("vitest-run", () => `pnpm vitest run libs/harness/domain/test/${slug}.test.ts`)
    .with("pnpm-harness-verify", () => `pnpm harness status --unit ${slug}`)
    .exhaustive()

describe("Adversarial Property-Based Security Policy Matrix (SPEC-0028 REQ-2.1, REQ-2.2)", () => {
  it.prop(
    "denies or escalates every obfuscated shell read or write targeting secrets, credentials, or daemon state",
    {
      target: ReadAndWriteProtectedShellTargetSchema,
      quoteKind: QuoteWrapKindSchema,
      wrapper: ShellWrapperKindSchema,
      verb: AllShellVerbSchema,
      unitWorkerMode: Schema.Boolean,
    },
    ({ target, quoteKind, wrapper, verb, unitWorkerMode }) => {
      const arg = applyShellQuoteObfuscation(target, quoteKind)
      const command = wrapObfuscatedShellCommand(verb, arg, wrapper)
      const verdict = classifyCommand(command, { unitWorkerMode })
      expect(verdict).toBe("deny")
    },
  )

  it.prop(
    "denies every obfuscated mutating shell command targeting stamps, caches, or readonly subtrees",
    {
      target: WriteProtectedShellTargetSchema,
      quoteKind: QuoteWrapKindSchema,
      wrapper: ShellWrapperKindSchema,
      verb: MutatingShellVerbSchema,
      unitWorkerMode: Schema.Boolean,
    },
    ({ target, quoteKind, wrapper, verb, unitWorkerMode }) => {
      const arg = applyShellQuoteObfuscation(target, quoteKind)
      const command = wrapObfuscatedShellCommand(verb, arg, wrapper)
      const verdict = classifyCommand(command, { unitWorkerMode })
      expect(verdict).toBe("deny")
    },
  )

  it("F-12: blocks ANSI-C escapes, flag/runner bypasses, stem wildcards, multi-char brackets, brace truncation, while preserving safe lint/doc reads", () => {
    for (const cmd of [
      "cat $'\\x2egit/harness/daemon.sock'",
      "$'cat .e\\x6ev'",
      "find libs -fprint .harness/verify-stamp.json",
      "sort -o .harness/verify-stamp.json a.txt",
      "git diff --output .harness/verify-stamp.json",
      "rg --pre sh daemon .harness/verify-stamp.json",
    ]) {
      expect(classifyCommand(cmd, { unitWorkerMode: false }), cmd).toBe("deny")
    }
    for (const nonAllowedCmd of [
      "nx exec -- echo hi",
      "pnpm --filter @harness/gates exec rm a.ts",
      "pnpm --filter @harness/gates dlx foo",
    ]) {
      expect(isCommandAllowed(nonAllowedCmd), nonAllowedCmd).toBe(false)
      expect(classifyCommand(nonAllowedCmd, { unitWorkerMode: false }), nonAllowedCmd).toBe(
        "escalate",
      )
    }
    expect(classifyCommand("rg --pre sh daemon libs/", { unitWorkerMode: false })).toBe("escalate")

    for (const pathTarget of [
      ".dev.vars.local",
      ".en?",
      ".dev.var?",
      "mutation-hma?*.ke?",
      ".git/harne*/auth-token?.json",
      ".e[no]v",
      "mutation-h[mn]ac.key",
      "/repo/{a,b,c,d,e,f,g,h,i}/secret.txt",
      "/repo/{a,{b,{c,d}}}/secret.txt",
    ]) {
      expect(classifyFileRead(pathTarget, { unitWorkerMode: false }).verdict, pathTarget).toBe(
        "deny",
      )
      expect(classifyFileWrite(pathTarget, { unitWorkerMode: false }).verdict, pathTarget).toBe(
        "deny",
      )
    }

    expect(classifyFileRead(".git", { unitWorkerMode: true }).verdict).toBe("deny")
    expect(classifyFileRead(".harness", { unitWorkerMode: true }).verdict).toBe("deny")

    for (const safeRead of [
      ".oxlintrc.json",
      "tools/oxlint/syntax-bans.js",
      "repos/effect/LLMS.md",
    ]) {
      expect(classifyFileRead(safeRead, { unitWorkerMode: false }).verdict, safeRead).toBe("allow")
    }
    for (const safeCmd of [
      "cat .oxlintrc.json",
      "rg syntax tools/oxlint",
      "cat repos/effect/LLMS.md",
    ]) {
      expect(classifyCommand(safeCmd, { unitWorkerMode: false }), safeCmd).toBe("allow")
    }
  })

  it.prop(
    "allows canonical benign workspace and read-only subtree doc inspection commands",
    {
      kind: BenignCommandKindSchema,
      slug: BenignModuleSlugSchema,
    },
    ({ kind, slug }) => {
      const command = formatBenignCommand(kind, slug)
      expect(classifyCommand(command, { unitWorkerMode: false })).toBe("allow")
      expect(classifyCommand("cat repos/effect/LLMS.md", { unitWorkerMode: false })).toBe("allow")
    },
  )

  it.prop(
    "denies obfuscated reads and writes targeting protected state and secrets across traversal and glob encodings",
    {
      target: ProtectedReadWritePathTargetSchema,
      prefix: ValidWorktreePrefixSchema,
      obfuscation: PathObfuscationKindSchema,
      unitWorkerMode: Schema.Boolean,
    },
    ({ target, prefix, obfuscation, unitWorkerMode }) => {
      const candidate = obfuscateFilePath(target, prefix, obfuscation)
      const readRes = classifyFileRead(candidate, { unitWorkerMode })
      const writeRes = classifyFileWrite(candidate, { unitWorkerMode })
      expect(readRes.verdict).toBe("deny")
      expect(writeRes.verdict).toBe("deny")
    },
  )

  it.prop(
    "denies obfuscated writes targeting stamps, caches, and read-only subtrees under coordinator and worker modes",
    {
      target: ProtectedWriteOnlyPathTargetSchema,
      prefix: ValidWorktreePrefixSchema,
      obfuscation: PathObfuscationKindSchema,
      unitWorkerMode: Schema.Boolean,
    },
    ({ target, prefix, obfuscation, unitWorkerMode }) => {
      const candidate = obfuscateFilePath(target, prefix, obfuscation)
      const writeRes = classifyFileWrite(candidate, { unitWorkerMode })
      expect(writeRes.verdict).toBe("deny")
    },
  )

  it.prop(
    "allows benign workspace and worktree source file reads and writes under both modes",
    {
      prefix: ValidWorktreePrefixSchema,
      slug: BenignModuleSlugSchema,
      unitWorkerMode: Schema.Boolean,
    },
    ({ prefix, slug, unitWorkerMode }) => {
      const benignPath = `${prefix}libs/harness/domain/src/${slug}.ts`
      expect(classifyFileRead(benignPath, { unitWorkerMode }).verdict).toBe("allow")
      expect(classifyFileWrite(benignPath, { unitWorkerMode }).verdict).toBe("allow")
    },
  )
})
