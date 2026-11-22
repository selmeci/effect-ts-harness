import { join } from "node:path"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { compareCodeUnits } from "@harness/contract"
import { ts } from "@harness/graph"
import type { SyncHostIo } from "@harness/service/host-io"
import { type GcFinding, readTextOrReport } from "./gc-helpers.js"

const HookMatcherEntrySchema = Schema.Struct({
  matcher: Schema.optional(Schema.String),
})

const HookMatcherContainerSchema = Schema.Struct({
  PreToolUse: Schema.optional(Schema.Array(HookMatcherEntrySchema)),
  PostToolUse: Schema.optional(Schema.Array(HookMatcherEntrySchema)),
})

const HookMatcherFileSchema = Schema.Struct({
  hooks: Schema.optional(HookMatcherContainerSchema),
  "effect-harness": Schema.optional(HookMatcherContainerSchema),
})

const decodeHookMatcherFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(HookMatcherFileSchema),
)

const GUARD_PAYLOAD_REL_PATH = "apps/harness-cli/src/commands/hook-guard-payload.ts"
const CLAUDE_HOOKS_REL_PATH = "adapters/claude-code/hooks.json"
const CLAUDE_README_REL_PATH = "adapters/claude-code/README.md"
const ANTIGRAVITY_HOOKS_REL_PATH = "adapters/antigravity/plugins/effect-harness/hooks.json"
const ANTIGRAVITY_README_REL_PATH = "adapters/antigravity/plugins/effect-harness/README.md"

const CANONICAL_ARRAY_NAMES = [
  "CLAUDE_CODE_READ_ONLY_TOOL_NAMES",
  "CLAUDE_CODE_WRITE_TOOL_NAMES",
  "CLAUDE_CODE_COMMAND_TOOL_NAMES",
  "ANTIGRAVITY_READ_ONLY_TOOL_NAMES",
  "ANTIGRAVITY_WRITE_TOOL_NAMES",
  "ANTIGRAVITY_COMMAND_TOOL_NAMES",
] as const

type CanonicalArrayName = (typeof CANONICAL_ARRAY_NAMES)[number]

interface AdapterToolSets {
  readonly read: ReadonlyArray<string>
  readonly write: ReadonlyArray<string>
  readonly command: ReadonlyArray<string>
}

export interface HookMatcherParityInput {
  readonly payloadSource: string
  readonly claudeHooksJson: string
  readonly antigravityHooksJson: string
  readonly claudeReadme: string
  readonly antigravityReadme: string
}

const makeParityFinding = (
  nodeId: string,
  location: string,
  message: string,
  action: string,
): GcFinding => ({
  kind: "hook-matcher-tool-parity",
  nodeId,
  location,
  message,
  action,
})

const extractCanonicalToolArrays = (
  payloadSource: string,
  findings: Array<GcFinding>,
): ReadonlyMap<CanonicalArrayName, ReadonlyArray<string>> | undefined => {
  const sf = ts.createSourceFile(
    GUARD_PAYLOAD_REL_PATH,
    payloadSource,
    ts.ScriptTarget.Latest,
    true,
  )
  const targetSet = new Set<string>(CANONICAL_ARRAY_NAMES)
  const extracted = new Map<CanonicalArrayName, ReadonlyArray<string>>()

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !targetSet.has(decl.name.text) || !decl.initializer)
        continue
      let expr: ts.Expression = decl.initializer
      while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
        expr = expr.expression
      }
      if (!ts.isArrayLiteralExpression(expr)) continue
      const items = expr.elements
        .filter(
          (el): el is ts.StringLiteral =>
            ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el),
        )
        .map((el) => el.text.trim())
        .filter((text) => text.length > 0)
      extracted.set(decl.name.text as CanonicalArrayName, items)
    }
  }

  let valid = true
  for (const name of CANONICAL_ARRAY_NAMES) {
    const vals = extracted.get(name)
    if (vals === undefined || vals.length === 0) {
      valid = false
      findings.push(
        makeParityFinding(
          `${GUARD_PAYLOAD_REL_PATH}:${name}`,
          GUARD_PAYLOAD_REL_PATH,
          `Missing or empty canonical adapter tool array '${name}' in '${GUARD_PAYLOAD_REL_PATH}'.`,
          `Export non-empty string-literal tuple '${name}' in '${GUARD_PAYLOAD_REL_PATH}'.`,
        ),
      )
    }
  }

  return valid ? extracted : undefined
}

const compileMatchers = (
  relPath: string,
  eventName: "PreToolUse" | "PostToolUse",
  entries: ReadonlyArray<{ readonly matcher?: string | undefined }>,
  findings: Array<GcFinding>,
): { readonly rawMatchers: ReadonlyArray<string>; readonly regexes: ReadonlyArray<RegExp> } => {
  const rawMatchers: Array<string> = []
  const regexes: Array<RegExp> = []
  for (const entry of entries) {
    if (entry.matcher === undefined || entry.matcher.trim().length === 0) continue
    const raw = entry.matcher.trim()
    rawMatchers.push(raw)
    match(Result.try(() => new RegExp(`^(?:${raw})$`)))
      .with({ _tag: "Success" }, ({ success }) => {
        regexes.push(success)
      })
      .with({ _tag: "Failure" }, () => {
        findings.push(
          makeParityFinding(
            `${relPath}:${eventName}:${raw}`,
            relPath,
            `Invalid ${eventName} matcher regex '${raw}' in '${relPath}'.`,
            `Fix invalid regex '${raw}' in '${relPath}'.`,
          ),
        )
      })
      .exhaustive()
  }
  return { rawMatchers, regexes }
}

const extractLifecycleEventBlock = (
  readme: string,
  headerPattern: RegExp,
  endPattern: RegExp,
): string | undefined => {
  const startMatch = headerPattern.exec(readme)
  if (!startMatch || startMatch.index === undefined) return undefined
  const rest = readme.slice(startMatch.index + startMatch[0].length)
  const endMatch = endPattern.exec(rest)
  return endMatch && endMatch.index !== undefined ? rest.slice(0, endMatch.index) : rest
}

const checkReadmeEventMatchers = (
  readmePath: string,
  eventName: "PreToolUse" | "PostToolUse",
  block: string | undefined,
  hooksMatchers: ReadonlyArray<string>,
  expectedPreTools: ReadonlyArray<string>,
  findings: Array<GcFinding>,
): void => {
  if (block === undefined) {
    findings.push(
      makeParityFinding(
        `${readmePath}:${eventName}`,
        readmePath,
        `Adapter README '${readmePath}' is missing documented '${eventName}' hook section.`,
        `Document '${eventName}' hook matchers in '${readmePath}' matching hooks.json.`,
      ),
    )
    return
  }

  const readmeMatchers = Array.from(block.matchAll(/Matcher\s+`([^`]+)`/g)).map((m) => m[1]!.trim())
  if (readmeMatchers.length > 0) {
    const hooksSet = new Set(hooksMatchers)
    const readmeSet = new Set(readmeMatchers)
    for (const m of readmeMatchers) {
      if (!hooksSet.has(m)) {
        findings.push(
          makeParityFinding(
            `${readmePath}:${eventName}:matcher:${m}`,
            readmePath,
            `README '${readmePath}' documents ${eventName} matcher '${m}', which is absent from hooks.json.`,
            `Sync ${eventName} matcher '${m}' between '${readmePath}' and hooks.json.`,
          ),
        )
      }
    }
    for (const m of hooksMatchers) {
      if (!readmeSet.has(m)) {
        findings.push(
          makeParityFinding(
            `${readmePath}:${eventName}:missing-matcher:${m}`,
            readmePath,
            `hooks.json defines ${eventName} matcher '${m}', which is undocumented in '${readmePath}'.`,
            `Document 'Matcher \`${m}\`' under ${eventName} in '${readmePath}'.`,
          ),
        )
      }
    }
  }

  if (eventName === "PreToolUse") {
    const inlineMatch = /Intercepts tool calls\s*\(([^)]+)\)/.exec(block)
    if (inlineMatch?.[1] !== undefined) {
      const documented = new Set(
        Array.from(inlineMatch[1].matchAll(/`([^`]+)`/g)).map((m) => m[1]!.trim()),
      )
      const expectedSet = new Set(expectedPreTools)
      for (const tool of [...expectedPreTools].sort(compareCodeUnits)) {
        if (!documented.has(tool)) {
          findings.push(
            makeParityFinding(
              `${readmePath}:PreToolUse:tool:${tool}`,
              readmePath,
              `README '${readmePath}' PreToolUse tool list omits '${tool}' enforced by hooks.json and '${GUARD_PAYLOAD_REL_PATH}'.`,
              `Add '\`${tool}\`' to the PreToolUse Intercepts tool calls list in '${readmePath}'.`,
            ),
          )
        }
      }
      for (const tool of [...documented].sort(compareCodeUnits)) {
        if (!expectedSet.has(tool)) {
          findings.push(
            makeParityFinding(
              `${readmePath}:PreToolUse:extra-tool:${tool}`,
              readmePath,
              `README '${readmePath}' PreToolUse tool list cites '${tool}', which is not in canonical adapter tools.`,
              `Remove or reconcile '${tool}' in '${readmePath}'.`,
            ),
          )
        }
      }
    }
  }
}

const checkSingleAdapterParity = (
  hooksPath: string,
  readmePath: string,
  rootKey: "hooks" | "effect-harness",
  hooksJson: string,
  readme: string,
  tools: AdapterToolSets,
  findings: Array<GcFinding>,
): void => {
  match(decodeHookMatcherFile(hooksJson))
    .with({ _tag: "None" }, () => {
      findings.push(
        makeParityFinding(
          hooksPath,
          hooksPath,
          `Failed to parse hook config JSON '${hooksPath}'.`,
          `Fix JSON in '${hooksPath}'.`,
        ),
      )
    })
    .with({ _tag: "Some" }, ({ value }) => {
      const container = rootKey === "hooks" ? value.hooks : value["effect-harness"]
      if (container === undefined) {
        findings.push(
          makeParityFinding(
            hooksPath,
            hooksPath,
            `Hook config '${hooksPath}' is missing required '${rootKey}' container.`,
            `Restore '${rootKey}' container in '${hooksPath}'.`,
          ),
        )
        return
      }
      const pre = compileMatchers(hooksPath, "PreToolUse", container.PreToolUse ?? [], findings)
      const post = compileMatchers(hooksPath, "PostToolUse", container.PostToolUse ?? [], findings)
      const allPreTools = [...tools.read, ...tools.write, ...tools.command]

      for (const tool of allPreTools) {
        if (!pre.regexes.some((re) => re.test(tool))) {
          findings.push(
            makeParityFinding(
              `${hooksPath}:PreToolUse:${tool}`,
              hooksPath,
              `Tool '${tool}' from '${GUARD_PAYLOAD_REL_PATH}' is missing from PreToolUse matchers in '${hooksPath}'.`,
              `Include '${tool}' in PreToolUse matchers of '${hooksPath}'.`,
            ),
          )
        }
      }
      for (const tool of tools.write) {
        if (!post.regexes.some((re) => re.test(tool))) {
          findings.push(
            makeParityFinding(
              `${hooksPath}:PostToolUse:${tool}`,
              hooksPath,
              `Write tool '${tool}' from '${GUARD_PAYLOAD_REL_PATH}' is missing from PostToolUse matchers in '${hooksPath}'.`,
              `Include '${tool}' in PostToolUse matchers of '${hooksPath}'.`,
            ),
          )
        }
      }

      const preBlock = extractLifecycleEventBlock(
        readme,
        /\*\*`PreToolUse`/,
        /\*\*`(?:PostToolUse|Stop)`/,
      )
      const postBlock = extractLifecycleEventBlock(readme, /\*\*`PostToolUse`/, /\*\*`Stop`/)
      checkReadmeEventMatchers(
        readmePath,
        "PreToolUse",
        preBlock,
        pre.rawMatchers,
        allPreTools,
        findings,
      )
      checkReadmeEventMatchers(
        readmePath,
        "PostToolUse",
        postBlock,
        post.rawMatchers,
        tools.write,
        findings,
      )
    })
    .exhaustive()
}

/** Pure evaluator for `hook-matcher-tool-parity` across hook-guard-payload, hooks.json, and adapter READMEs. */
export const evaluateHookMatcherToolParity = (
  input: HookMatcherParityInput,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  const arrays = extractCanonicalToolArrays(input.payloadSource, findings)
  if (arrays === undefined) return findings

  const claudeTools: AdapterToolSets = {
    read: arrays.get("CLAUDE_CODE_READ_ONLY_TOOL_NAMES")!,
    write: arrays.get("CLAUDE_CODE_WRITE_TOOL_NAMES")!,
    command: arrays.get("CLAUDE_CODE_COMMAND_TOOL_NAMES")!,
  }
  const antigravityTools: AdapterToolSets = {
    read: arrays.get("ANTIGRAVITY_READ_ONLY_TOOL_NAMES")!,
    write: arrays.get("ANTIGRAVITY_WRITE_TOOL_NAMES")!,
    command: arrays.get("ANTIGRAVITY_COMMAND_TOOL_NAMES")!,
  }

  checkSingleAdapterParity(
    CLAUDE_HOOKS_REL_PATH,
    CLAUDE_README_REL_PATH,
    "hooks",
    input.claudeHooksJson,
    input.claudeReadme,
    claudeTools,
    findings,
  )
  checkSingleAdapterParity(
    ANTIGRAVITY_HOOKS_REL_PATH,
    ANTIGRAVITY_README_REL_PATH,
    "effect-harness",
    input.antigravityHooksJson,
    input.antigravityReadme,
    antigravityTools,
    findings,
  )
  return findings
}

/** Checks PreToolUse/PostToolUse hook matcher & README parity against canonical CLI guard tool sets. */
export const checkHookMatcherToolParity = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const payloadAbs = join(repoRoot, GUARD_PAYLOAD_REL_PATH)
  if (!hostIo.existsSync(payloadAbs)) {
    return
  }
  const readReq = (relPath: string): string | undefined => {
    const abs = join(repoRoot, relPath)
    if (!hostIo.existsSync(abs)) {
      findings.push(
        makeParityFinding(
          relPath,
          relPath,
          `Missing required hook configuration or documentation file '${relPath}'.`,
          `Restore '${relPath}' for adapter hook parity.`,
        ),
      )
      return undefined
    }
    return readTextOrReport(abs, hostIo, repoRoot, findings)
  }
  const payloadSource = readTextOrReport(payloadAbs, hostIo, repoRoot, findings)
  const claudeHooksJson = readReq(CLAUDE_HOOKS_REL_PATH)
  const antigravityHooksJson = readReq(ANTIGRAVITY_HOOKS_REL_PATH)
  const claudeReadme = readReq(CLAUDE_README_REL_PATH)
  const antigravityReadme = readReq(ANTIGRAVITY_README_REL_PATH)
  if (
    payloadSource === undefined ||
    claudeHooksJson === undefined ||
    antigravityHooksJson === undefined ||
    claudeReadme === undefined ||
    antigravityReadme === undefined
  ) {
    return
  }
  for (const f of evaluateHookMatcherToolParity({
    payloadSource,
    claudeHooksJson,
    antigravityHooksJson,
    claudeReadme,
    antigravityReadme,
  })) {
    findings.push(f)
  }
}
