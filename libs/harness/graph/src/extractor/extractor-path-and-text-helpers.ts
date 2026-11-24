import { createHash } from "node:crypto"
import * as path from "node:path"
import type { SyncHostReader } from "@harness/service/host-io"
import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import { ts } from "ts-morph"
import { PackageTag } from "../model.js"

export const WORKSPACE_PACKAGE_TAG_MAP: Readonly<Record<string, PackageTag>> = {
  contract: PackageTag.make("contract"),
  domain: PackageTag.make("domain"),
  core: PackageTag.make("domain"),
  service: PackageTag.make("service"),
  infra: PackageTag.make("infra"),
  app: PackageTag.make("app"),
}

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

export const PackageJsonSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  nx: Schema.optional(Schema.Struct({ tags: Schema.optional(Schema.Array(Schema.String)) })),
})

export const decodePackageJson = Schema.decodeOption(Schema.fromJsonString(PackageJsonSchema))

export const resolvePackageTag = (
  repoRoot: string,
  relFilePath: string,
  hostIo?: SyncHostReader,
): PackageTag => {
  if (relFilePath.startsWith("apps/") || relFilePath.includes("/apps/")) return "app"
  if (hostIo !== undefined) {
    let currentDir = path.dirname(path.join(repoRoot, relFilePath))
    while (currentDir.length >= repoRoot.length) {
      const pkgPath = path.join(currentDir, "package.json")
      if (hostIo.existsSync(pkgPath)) {
        const content = hostIo.readTextSync(pkgPath)
        const opt = decodePackageJson(content)
        const tags = match(opt)
          .with({ _tag: "Some" }, ({ value }) => value.nx?.tags ?? [])
          .with({ _tag: "None" }, () => [] as ReadonlyArray<string>)
          .exhaustive()
        if (tags.length > 0) {
          if (tags.includes("type:domain") || tags.includes("type:core")) return "domain"
          if (tags.includes("type:infra")) return "infra"
          if (tags.includes("type:app")) return "app"
          if (tags.includes("type:contract") && !tags.includes("type:service")) return "contract"
          if (tags.includes("type:service")) return "service"
          if (tags.includes("type:contract")) return "contract"
        }
        break
      }
      const parent = path.dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
  }
  if (relFilePath.includes("/domain/") || relFilePath.includes("/core/")) return "domain"
  if (relFilePath.includes("/infra/")) return "infra"
  if (relFilePath.includes("/contract/")) return "contract"
  if (relFilePath.includes("/service/")) return "service"
  return "service"
}

export const resolveRepoRoot = (startDir: string, hostIo?: SyncHostReader): string => {
  const exists = (p: string) => (hostIo !== undefined ? hostIo.existsSync(p) : ts.sys.fileExists(p))
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (exists(path.join(curr, "pnpm-workspace.yaml"))) return curr
    curr = path.dirname(curr)
  }
  return startDir
}

const isTestTitleCalleeRoot = (root: string): boolean =>
  root === "describe" || root === "it" || root === "test"

const unwrapCalleeRootName = (expr: ts.Expression): string | undefined => {
  let current: ts.Expression = expr
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : undefined
}

const isTitleLiteralLike = (node: ts.Expression): boolean =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateExpression(node)

export const stripCommentsAndTestTitles = (code: string): string => {
  const sf = ts.createSourceFile("strip.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const spans: Array<{
    readonly start: number
    readonly end: number
    readonly replacement: string
  }> = []
  const seenComments = new Set<string>()

  const addComments = (ranges: ReadonlyArray<ts.CommentRange> | undefined): void => {
    if (ranges === undefined) return
    for (const r of ranges) {
      const key = `${String(r.pos)}:${String(r.end)}`
      if (seenComments.has(key)) continue
      seenComments.add(key)
      spans.push({ start: r.pos, end: r.end, replacement: " " })
    }
  }

  const visit = (node: ts.Node): void => {
    addComments(ts.getLeadingCommentRanges(code, node.pos))
    addComments(ts.getTrailingCommentRanges(code, node.end))

    if (ts.isCallExpression(node)) {
      const root = unwrapCalleeRootName(node.expression)
      const firstArg = node.arguments[0]
      if (
        root !== undefined &&
        isTestTitleCalleeRoot(root) &&
        firstArg !== undefined &&
        isTitleLiteralLike(firstArg)
      ) {
        spans.push({
          start: firstArg.getStart(sf),
          end: firstArg.getEnd(),
          replacement: '""',
        })
      }
    }

    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      spans.push({ start: node.getStart(sf), end: node.getEnd(), replacement: '""' })
      return
    }

    for (const child of node.getChildren(sf)) {
      visit(child)
    }
  }

  visit(sf)
  if (spans.length === 0) return code

  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const parts: Array<string> = []
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) continue
    parts.push(code.slice(cursor, span.start), span.replacement)
    cursor = span.end
  }
  parts.push(code.slice(cursor))
  return parts.join("")
}

export const computeDynamicPaths = (
  repoRoot: string,
  workspaceRoot: string,
  hostIo?: SyncHostReader,
): Record<string, Array<string>> => {
  const graphNodeModules = path.join(workspaceRoot, "libs/harness/graph/node_modules")
  const paths: Record<string, Array<string>> = {
    effect: [
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/dist/index.d.ts"),
      path.join(graphNodeModules, "effect/dist/index.d.ts"),
      path.join(repoRoot, "libs/harness/graph/node_modules/effect"),
      path.join(graphNodeModules, "effect"),
    ],
    "effect/*": [
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/dist/*.d.ts"),
      path.join(graphNodeModules, "effect/dist/*.d.ts"),
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/*"),
      path.join(graphNodeModules, "effect/*"),
    ],
    "effect/cli": [
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/dist/cli/index.d.ts"),
      path.join(graphNodeModules, "effect/dist/cli/index.d.ts"),
    ],
    "effect/process": [
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/dist/process/index.d.ts"),
      path.join(graphNodeModules, "effect/dist/process/index.d.ts"),
    ],
    "effect/persistence": [
      path.join(repoRoot, "libs/harness/graph/node_modules/effect/dist/persistence/index.d.ts"),
      path.join(graphNodeModules, "effect/dist/persistence/index.d.ts"),
    ],
    "@effect/platform-node": [
      path.join(repoRoot, "apps/sample/node_modules/@effect/platform-node/dist/index.d.ts"),
      path.join(workspaceRoot, "node_modules/@effect/platform-node"),
    ],
    "ts-pattern": [
      path.join(repoRoot, "node_modules/ts-pattern"),
      path.join(workspaceRoot, "node_modules/ts-pattern"),
    ],
    "@harness/contract": [
      path.join(repoRoot, "libs/harness/contract/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/contract/src/index.ts"),
    ],
    "@harness/service": [
      path.join(repoRoot, "libs/harness/service/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/service/src/index.ts"),
    ],
    "@harness/infra": [
      path.join(repoRoot, "libs/harness/infra/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/infra/src/index.ts"),
    ],
    "@harness/gates": [
      path.join(repoRoot, "libs/harness/gates/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/gates/src/index.ts"),
    ],
    "@harness/graph": [
      path.join(repoRoot, "libs/harness/graph/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/graph/src/index.ts"),
    ],
    "@harness/decision": [
      path.join(repoRoot, "libs/harness/decision/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/decision/src/index.ts"),
    ],
    "@harness/ingest": [
      path.join(repoRoot, "libs/harness/ingest/src/index.ts"),
      path.join(workspaceRoot, "libs/harness/ingest/src/index.ts"),
    ],
    "@harness/sample-contract": [path.join(repoRoot, "libs/sample/contract/src/index.ts")],
    "@harness/sample-service": [path.join(repoRoot, "libs/sample/service/src/index.ts")],
    "@harness/sample-domain": [path.join(repoRoot, "libs/sample/domain/src/index.ts")],
    "@harness/sample-infra": [path.join(repoRoot, "libs/sample/infra/src/index.ts")],
  }
  const libsDir = path.join(repoRoot, "libs")
  if (hostIo !== undefined && hostIo.existsSync(libsDir)) {
    for (const s of hostIo.readdirSync(libsDir)) {
      if (!s.isDirectory || s.name === "harness") continue
      for (const tier of ["contract", "service", "domain", "core", "infra"]) {
        const entry = path.join(libsDir, s.name, tier, "src", "index.ts")
        paths[`@harness/${s.name}-${tier}`] = [entry]
        paths[`@effect-${s.name}/${tier}`] = [entry]
        paths[`@${s.name}/${tier}`] = [entry]
      }
    }
  }
  return paths
}

export const resolveImportSpecToRelFile = (
  fromRelPath: string,
  spec: string,
  repoRoot: string,
  fileMap: ReadonlyMap<string, unknown>,
  dynamicPaths: Record<string, Array<string>>,
): string | null => {
  if (spec.startsWith(".")) {
    const fromDir = path.dirname(path.join(repoRoot, fromRelPath))
    const rel = path.relative(repoRoot, path.resolve(fromDir, spec)).replace(/\\/g, "/")
    for (const c of [
      rel,
      rel.replace(/\.js$/, ".ts"),
      rel.replace(/\.jsx$/, ".tsx"),
      `${rel}.ts`,
      `${rel}/index.ts`,
    ]) {
      if (fileMap.has(c)) return c
    }
  }
  for (const [alias, targets] of Object.entries(dynamicPaths)) {
    if (spec === alias && targets[0] !== undefined) {
      const rel = path.relative(repoRoot, targets[0]).replace(/\\/g, "/")
      if (fileMap.has(rel)) return rel
    }
  }
  return null
}

export const resolveContainedRelPath = (
  repoRoot: string,
  rawPath: string,
  hostIo?: SyncHostReader,
): string | null => {
  const trimmed = rawPath.trim()
  if (trimmed.length === 0) return null
  const logicalRoot = path.resolve(repoRoot)
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(logicalRoot, trimmed)
  const rel = path.relative(logicalRoot, abs).replace(/\\/g, "/")
  if (rel.length === 0 || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return null
  if (hostIo === undefined) return rel
  return Result.getOrElse(
    Result.try(() => {
      if (hostIo.existsSync(logicalRoot)) {
        const realRoot = hostIo.realpathSync(logicalRoot)
        let probe = logicalRoot
        for (const seg of rel.split("/")) {
          probe = path.join(probe, seg)
          if (hostIo.isSymbolicLinkSync(probe) && !hostIo.existsSync(probe)) return null
          if (!hostIo.existsSync(probe)) break
          const realRel = path.relative(realRoot, hostIo.realpathSync(probe)).replace(/\\/g, "/")
          if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null
        }
      }
      return rel
    }),
    () => null,
  )
}
