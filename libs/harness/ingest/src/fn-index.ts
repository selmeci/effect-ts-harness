import * as fs from "node:fs"
import * as path from "node:path"
import { Lang, parse } from "@ast-grep/napi"
import { Effect, Option, Schema } from "effect"

export type PackageTag = "contract" | "domain" | "service" | "infra" | "app"

export interface IndexedEffectFn {
  readonly qualname: string
  readonly spanName: string
  readonly exportName: string
  readonly file: string
  readonly line: number
  readonly packageTag: PackageTag
  readonly isStub: boolean
}

export interface WorkspaceFnIndex {
  readonly bySpanName: ReadonlyMap<string, IndexedEffectFn>
  readonly duplicates: ReadonlyArray<string>
}

const PackageJsonSchema = Schema.Struct({
  nx: Schema.optional(
    Schema.Struct({
      tags: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

const decodePackageJson = Schema.decodeOption(Schema.fromJsonString(PackageJsonSchema))

export const indexEffectFnsInFile = (
  filePath: string,
  sourceText: string,
  packageTag: PackageTag,
): ReadonlyArray<IndexedEffectFn> => {
  const root = parse(Lang.TypeScript, sourceText).root()
  const results: Array<IndexedEffectFn> = []

  for (const exp of root.findAll({ rule: { kind: "export_statement" } })) {
    for (const d of exp.findAll({ rule: { kind: "variable_declarator" } })) {
      const nameNode = d.field("name")
      if (!nameNode) continue
      const exportName = nameNode.text()

      const valueNode = d.field("value")
      if (!valueNode || valueNode.kind() !== "call_expression") continue

      const fnCall = valueNode.field("function")
      if (!fnCall || fnCall.kind() !== "call_expression") continue

      const fnCallee = fnCall.field("function")
      if (!fnCallee || fnCallee.text() !== "Effect.fn") continue

      const fnArgs = fnCall.field("arguments")
      if (!fnArgs) continue

      const strNode = fnArgs.children().find((c) => c.kind() === "string")
      if (!strNode) continue

      const spanName = strNode.text().replace(/^["'`]|["'`]$/g, "")
      if (!spanName) continue

      const line = exp.range().start.line + 1
      const qualname = `${filePath}#${exportName}`

      const calls = valueNode.findAll({ rule: { kind: "call_expression" } })
      const isStub = calls.some((call) => {
        const callee = call.field("function") ?? call.children()[0]
        if (!callee) return false
        const t = callee.text()
        return t === "stub" || t.endsWith(".stub")
      })

      results.push({
        qualname,
        spanName,
        exportName,
        file: filePath,
        line,
        packageTag,
        isStub,
      })
    }
  }

  return results
}

export const validateUniqueSpanNames = (fns: ReadonlyArray<IndexedEffectFn>): WorkspaceFnIndex => {
  const bySpanName = new Map<string, IndexedEffectFn>()
  const duplicates = new Set<string>()

  for (const fn of fns) {
    if (bySpanName.has(fn.spanName)) {
      duplicates.add(fn.spanName)
    } else {
      bySpanName.set(fn.spanName, fn)
    }
  }

  return {
    bySpanName,
    duplicates: Array.from(duplicates),
  }
}

const resolvePackageTag = (repoRoot: string, relFilePath: string): PackageTag => {
  if (relFilePath.startsWith("apps/") || relFilePath.includes("/apps/")) {
    return "app"
  }
  let currentDir = path.dirname(path.join(repoRoot, relFilePath))
  while (currentDir.length >= repoRoot.length) {
    const pkgPath = path.join(currentDir, "package.json")
    if (fs.existsSync(pkgPath)) {
      const content = fs.readFileSync(pkgPath, "utf-8")
      const opt = decodePackageJson(content)
      if (Option.isSome(opt) && opt.value.nx?.tags) {
        const tags = opt.value.nx.tags
        if (tags.includes("type:domain")) return "domain"
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
  if (relFilePath.includes("/domain/")) return "domain"
  if (relFilePath.includes("/infra/")) return "infra"
  if (relFilePath.includes("/contract/")) return "contract"
  if (relFilePath.includes("/service/")) return "service"
  if (relFilePath.startsWith("apps/")) return "app"
  return "service"
}

const findSrcTsFiles = (repoRoot: string, subDir: string): ReadonlyArray<string> => {
  const results: Array<string> = []
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".nx" || e.name === "test") {
        continue
      }
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/")
        if (rel.includes("/src/")) {
          results.push(rel)
        }
      }
    }
  }
  walk(path.join(repoRoot, subDir))
  return results
}

export const buildWorkspaceFnIndex = (repoRoot: string): Effect.Effect<WorkspaceFnIndex> =>
  Effect.gen(function* () {
    const allFns: Array<IndexedEffectFn> = []
    const files = [...findSrcTsFiles(repoRoot, "libs"), ...findSrcTsFiles(repoRoot, "apps")]
    for (const file of files) {
      const fullPath = path.join(repoRoot, file)
      if (!fs.existsSync(fullPath)) continue
      const content = yield* Effect.try({
        try: () => fs.readFileSync(fullPath, "utf-8"),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null))
      if (content === null) continue
      const tag = resolvePackageTag(repoRoot, file)
      const fns = indexEffectFnsInFile(file, content, tag)
      allFns.push(...fns)
    }
    return validateUniqueSpanNames(allFns)
  })
