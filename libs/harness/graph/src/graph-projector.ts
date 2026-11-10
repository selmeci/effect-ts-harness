import * as fs from "node:fs"
import * as path from "node:path"
import { Lang, parse } from "@ast-grep/napi"
import { Effect, Schema } from "effect"
import * as Graph from "effect/Graph"
import { Node, Project, SyntaxKind, ts, VariableDeclarationKind } from "ts-morph"
import { match } from "ts-pattern"
import { decideGraphInference } from "./datalog-engine.js"
import { verifySubgraphMonomorphism } from "./graph-engine.js"
import { applyDpoPatchToGraph } from "./graph-rewrite.js"
import {
  type EffectFnNode,
  type EntityNode,
  GraphPatch,
  type HarnessGraph,
  type MigrationTupleRelation,
  NodeKey,
  type PlaysRoleEdge,
  RelationId,
  type RelationNode,
  RewriteCandidate,
  type RewritePhase,
  RewriteRuleId,
  type SchemaDefNode,
  type ServiceLayerNode,
  type ServiceTagNode,
  type TaggedErrorNode,
  type VitestCaseNode,
  getNodeKey,
} from "./model.js"
import {
  evaluateOverlayDiagnostics,
  extractTypeAwareGraphFromSource,
  getOrCreateWarmProgramSession,
  resolvePackageTag,
  resolveRepoRoot,
  type SourceFileInput,
} from "./type-extractor.js"

export const TargetFilePath = Schema.NonEmptyString.pipe(Schema.brand("TargetFilePath"))
export type TargetFilePath = typeof TargetFilePath.Type

export const TypeScriptSnippet = Schema.String.pipe(Schema.brand("TypeScriptSnippet"))
export type TypeScriptSnippet = typeof TypeScriptSnippet.Type

export const SpecificationRef = Schema.NonEmptyString.pipe(Schema.brand("SpecificationRef"))
export type SpecificationRef = typeof SpecificationRef.Type

export const CodeModEngineKind = Schema.Literals(["ts-morph", "ast-grep"]).pipe(
  Schema.brand("CodeModEngineKind"),
)
export type CodeModEngineKind = typeof CodeModEngineKind.Type

export const CodeModActionKind = Schema.Literals([
  "insert-declaration",
  "update-signature",
  "replace-expression",
  "remove-declaration",
  "ensure-import",
]).pipe(Schema.brand("CodeModActionKind"))
export type CodeModActionKind = typeof CodeModActionKind.Type

export const BisectionProbeCount = Schema.Natural.pipe(Schema.brand("BisectionProbeCount"))
export type BisectionProbeCount = typeof BisectionProbeCount.Type

export const AstCodeModOperation = Schema.Struct({
  ruleId: RewriteRuleId,
  engine: CodeModEngineKind,
  action: CodeModActionKind,
  targetFile: TargetFilePath,
  targetSymbol: Schema.optionalKey(NodeKey),
  targetRelation: Schema.optionalKey(RelationId),
  snippet: TypeScriptSnippet,
  rationale: SpecificationRef,
})
export type AstCodeModOperation = typeof AstCodeModOperation.Type

export const ShadowFileOverlay = Schema.Struct({
  targetFile: TargetFilePath,
  content: TypeScriptSnippet,
})
export type ShadowFileOverlay = typeof ShadowFileOverlay.Type

export const AstProjectionResult = Schema.Struct({
  operations: Schema.Array(AstCodeModOperation),
  overlays: Schema.Array(ShadowFileOverlay),
  roundTripVerified: Schema.Boolean,
  compilerDiagnostics: Schema.Array(Schema.String),
  bisectionProbes: BisectionProbeCount,
  skippedRuleIds: Schema.Array(RewriteRuleId),
})
export type AstProjectionResult = typeof AstProjectionResult.Type

export interface GraphProjectorInput {
  readonly initialGraph?: HarnessGraph | undefined
  readonly targetGraph: HarnessGraph
  readonly patches: ReadonlyArray<GraphPatch>
  readonly appliedRewrites?: ReadonlyArray<RewriteCandidate> | undefined
  readonly workspaceRoot?: TargetFilePath | string | undefined
  readonly existingFiles?: Readonly<Record<string, string>> | undefined
  readonly verifyRoundTrip?: boolean | undefined
  readonly forceFailRuleIds?: ReadonlyArray<RewriteRuleId | string> | undefined
}

export class GraphProjectorError extends Schema.TaggedError<GraphProjectorError>()(
  "GraphProjectorError",
  {
    ruleId: Schema.optionalKey(RewriteRuleId),
    targetFile: Schema.optionalKey(TargetFilePath),
    reason: Schema.NonEmptyString,
    message: Schema.optionalKey(Schema.String),
  },
) {}

const sanitizeIdentifier = (raw: string): string => {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "")
  if (cleaned.length === 0) return "Synthesized"
  return /^[0-9]/.test(cleaned) ? `S_${cleaned}` : cleaned
}

const normalizeRelPath = (repoRoot: string, rawPath: string): string => {
  const normalized = (path.isAbsolute(rawPath) ? path.relative(repoRoot, rawPath) : rawPath)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
  return normalized.length > 0 ? normalized : "libs/domain/src/synthesized.ts"
}

const computeRelativeModuleSpec = (fromFile: string, toFile: string): string => {
  const fromDir = path.posix.dirname(fromFile)
  let rel = path.posix.relative(fromDir, toFile)
  if (!rel.startsWith(".")) {
    rel = `./${rel}`
  }
  return rel.replace(/\.tsx?$/, ".js")
}

interface ProjectorContext {
  readonly repoRoot: string
  readonly project: Project
  readonly initialContents: Map<string, string>
  readonly modifiedFiles: Set<string>
  readonly exportedSymbolsByFile: Map<string, Set<string>>
  readonly operations: Array<AstCodeModOperation>
  readonly targetEntitiesByKey: Map<string, EntityNode>
  readonly targetRelationsById: Map<string, RelationNode>
  readonly targetEdgesByRelId: Map<string, Array<PlaysRoleEdge>>
}

const readInitialFileContent = (
  repoRoot: string,
  relPath: string,
  existingFiles?: Readonly<Record<string, string>>,
): string | undefined => {
  if (existingFiles !== undefined) {
    if (existingFiles[relPath] !== undefined) return existingFiles[relPath]
    const absKey = path.resolve(repoRoot, relPath).replace(/\\/g, "/")
    if (existingFiles[absKey] !== undefined) return existingFiles[absKey]
  }
  const fullPath = path.resolve(repoRoot, relPath)
  if (fs.existsSync(fullPath)) {
    return fs.readFileSync(fullPath, "utf8")
  }
  return undefined
}

const getOrCreateSourceFile = (ctx: ProjectorContext, relFile: string) => {
  const norm = normalizeRelPath(ctx.repoRoot, relFile)
  const memPath = `/${norm}`
  let sf = ctx.project.getSourceFile(memPath)
  if (sf === undefined) {
    const initial = ctx.initialContents.get(norm) ?? ""
    sf = ctx.project.createSourceFile(memPath, initial, { overwrite: true })
  }
  return { sf, norm }
}

const recordExportedSymbol = (ctx: ProjectorContext, relFile: string, symbolName: string): void => {
  let set = ctx.exportedSymbolsByFile.get(relFile)
  if (set === undefined) {
    set = new Set<string>()
    ctx.exportedSymbolsByFile.set(relFile, set)
  }
  set.add(symbolName)
}

const ensureNamedImport = (
  ctx: ProjectorContext,
  relFile: string,
  moduleSpec: string,
  namedImports: ReadonlyArray<string>,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, relFile)
  const existingDecl = sf
    .getImportDeclarations()
    .find((d) => d.getModuleSpecifierValue() === moduleSpec)
  const addedNames: Array<string> = []

  if (existingDecl !== undefined) {
    const currentNames = new Set(existingDecl.getNamedImports().map((n) => n.getName()))
    for (const name of namedImports) {
      if (!currentNames.has(name)) {
        existingDecl.addNamedImport(name)
        addedNames.push(name)
      }
    }
  } else if (namedImports.length > 0) {
    sf.insertImportDeclaration(0, {
      moduleSpecifier: moduleSpec,
      namedImports: [...namedImports],
    })
    addedNames.push(...namedImports)
  }

  if (addedNames.length > 0) {
    ctx.modifiedFiles.add(norm)
    ctx.operations.push({
      ruleId,
      engine: CodeModEngineKind.make("ts-morph"),
      action: CodeModActionKind.make("ensure-import"),
      targetFile: TargetFilePath.make(norm),
      snippet: TypeScriptSnippet.make(
        `import { ${addedNames.join(", ")} } from "${moduleSpec}"`,
      ),
      rationale: SpecificationRef.make(rationale),
    })
  }
}

const resolveFileForEntityKey = (ctx: ProjectorContext, entityKey: string): string | undefined => {
  const ent = ctx.targetEntitiesByKey.get(entityKey)
  if (ent === undefined) return undefined
  return match(ent)
    .with({ _tag: "EffectFn" }, (n) => n.file)
    .with({ _tag: "ServiceTag" }, (n) => n.file)
    .with({ _tag: "ServiceLayer" }, (n) => n.file)
    .with({ _tag: "TaggedError" }, (n) => n.file)
    .with({ _tag: "SchemaDef" }, (n) => n.file)
    .with({ _tag: "VitestCase" }, (n) => n.testFile)
    .with({ _tag: "PatternDoc" }, (n) => n.path)
    .with({ _tag: "AdrDoc" }, (n) => n.path)
    .with({ _tag: "EarsSpec" }, (n) => n.path)
    .exhaustive()
}

const resolveExportNameForEntityKey = (
  ctx: ProjectorContext,
  entityKey: string,
): string | undefined => {
  const ent = ctx.targetEntitiesByKey.get(entityKey)
  if (ent !== undefined) {
    return match(ent)
      .with({ _tag: "EffectFn" }, (n) => sanitizeIdentifier(n.qualname.split("#").pop() ?? n.spanName))
      .with({ _tag: "ServiceTag" }, (n) => sanitizeIdentifier(n.name))
      .with(
        { _tag: "ServiceLayer" },
        (n) => sanitizeIdentifier(n.qualname.split("#").pop() ?? "SynthesizedLive"),
      )
      .with({ _tag: "TaggedError" }, (n) => sanitizeIdentifier(n.errorTag))
      .with({ _tag: "SchemaDef" }, (n) => sanitizeIdentifier(n.schemaName))
      .with(
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        () => undefined,
      )
      .exhaustive()
  }
  const rawTail = entityKey.split(":").slice(1).join(":").split("#").pop()
  return rawTail !== undefined && rawTail.length > 0 ? sanitizeIdentifier(rawTail) : undefined
}

const projectSchemaDefNode = (
  ctx: ProjectorContext,
  node: SchemaDefNode,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file)
  const schemaIdent = sanitizeIdentifier(node.schemaName)
  ensureNamedImport(ctx, norm, "effect", ["Schema"], ruleId, rationale)

  const existingVar = sf.getVariableDeclaration(schemaIdent)
  if (existingVar !== undefined) {
    const init = existingVar.getInitializer()
    const initText = init?.getText() ?? ""
    if (
      node.isBranded === true &&
      !initText.includes("Schema.brand") &&
      !initText.includes(".brand(")
    ) {
      const nextInit = `${initText || "Schema.NonEmptyString"}.pipe(Schema.brand("${schemaIdent}"))`
      existingVar.setInitializer(nextInit)
      if (sf.getTypeAlias(schemaIdent) === undefined) {
        sf.addTypeAlias({
          isExported: true,
          name: schemaIdent,
          type: `typeof ${schemaIdent}.Type`,
        })
      }
      ctx.modifiedFiles.add(norm)
      recordExportedSymbol(ctx, norm, schemaIdent)
      ctx.operations.push({
        ruleId,
        engine: CodeModEngineKind.make("ts-morph"),
        action: CodeModActionKind.make("replace-expression"),
        targetFile: TargetFilePath.make(norm),
        targetSymbol: NodeKey.make(getNodeKey(node)),
        snippet: TypeScriptSnippet.make(
          `export const ${schemaIdent} = ${nextInit}\nexport type ${schemaIdent} = typeof ${schemaIdent}.Type`,
        ),
        rationale: SpecificationRef.make(rationale),
      })
    }
    return
  }

  const fieldIdIdent = `${schemaIdent}Id`
  const snippetLines: Array<string> = []
  if (sf.getVariableDeclaration(fieldIdIdent) === undefined && schemaIdent.endsWith("Input")) {
    sf.addVariableStatement({
      isExported: true,
      declarationKind: VariableDeclarationKind.Const,
      declarations: [
        {
          name: fieldIdIdent,
          initializer: `Schema.NonEmptyString.pipe(Schema.brand("${fieldIdIdent}"))`,
        },
      ],
    })
    sf.addTypeAlias({
      isExported: true,
      name: fieldIdIdent,
      type: `typeof ${fieldIdIdent}.Type`,
    })
    recordExportedSymbol(ctx, norm, fieldIdIdent)
    snippetLines.push(
      `export const ${fieldIdIdent} = Schema.NonEmptyString.pipe(Schema.brand("${fieldIdIdent}"))`,
      `export type ${fieldIdIdent} = typeof ${fieldIdIdent}.Type`,
    )
  }

  const initializer = schemaIdent.endsWith("Input")
    ? `Schema.Struct({ id: ${fieldIdIdent} }).pipe(Schema.brand("${schemaIdent}"))`
    : `Schema.NonEmptyString.pipe(Schema.brand("${schemaIdent}"))`

  sf.addVariableStatement({
    isExported: true,
    declarationKind: VariableDeclarationKind.Const,
    declarations: [
      {
        name: schemaIdent,
        initializer,
      },
    ],
  })
  if (sf.getTypeAlias(schemaIdent) === undefined) {
    sf.addTypeAlias({
      isExported: true,
      name: schemaIdent,
      type: `typeof ${schemaIdent}.Type`,
    })
  }

  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, schemaIdent)
  snippetLines.push(
    `export const ${schemaIdent} = ${initializer}`,
    `export type ${schemaIdent} = typeof ${schemaIdent}.Type`,
  )
  ctx.operations.push({
    ruleId,
    engine: CodeModEngineKind.make("ts-morph"),
    action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(snippetLines.join("\n")),
    rationale: SpecificationRef.make(rationale),
  })
}

const projectTaggedErrorNode = (
  ctx: ProjectorContext,
  node: TaggedErrorNode,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file)
  const errIdent = sanitizeIdentifier(node.errorTag)
  ensureNamedImport(ctx, norm, "effect", ["Schema"], ruleId, rationale)

  if (sf.getClass(errIdent) !== undefined || sf.getVariableDeclaration(errIdent) !== undefined) {
    recordExportedSymbol(ctx, norm, errIdent)
    return
  }

  const reasonIdent = `${errIdent}Reason`
  if (sf.getVariableDeclaration(reasonIdent) === undefined) {
    sf.addVariableStatement({
      isExported: true,
      declarationKind: VariableDeclarationKind.Const,
      declarations: [
        {
          name: reasonIdent,
          initializer: `Schema.NonEmptyString.pipe(Schema.brand("${reasonIdent}"))`,
        },
      ],
    })
    sf.addTypeAlias({
      isExported: true,
      name: reasonIdent,
      type: `typeof ${reasonIdent}.Type`,
    })
    recordExportedSymbol(ctx, norm, reasonIdent)
  }

  const clsSnippet = `export class ${errIdent} extends Schema.TaggedError<${errIdent}>()("${node.errorTag}", {\n  reason: ${reasonIdent},\n}) {}`
  sf.addStatements(clsSnippet)
  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, errIdent)
  ctx.operations.push({
    ruleId,
    engine: CodeModEngineKind.make("ts-morph"),
    action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(clsSnippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const projectServiceTagNode = (
  ctx: ProjectorContext,
  node: ServiceTagNode,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file)
  const svcIdent = sanitizeIdentifier(node.name)
  ensureNamedImport(ctx, norm, "effect", ["Context", "Effect"], ruleId, rationale)

  if (sf.getClass(svcIdent) !== undefined || sf.getVariableDeclaration(svcIdent) !== undefined) {
    recordExportedSymbol(ctx, norm, svcIdent)
    return
  }

  const clsSnippet = `export class ${svcIdent} extends Context.Service<${svcIdent}, {\n  readonly execute: () => Effect.Effect<void>\n}>()("${node.tagId}") {}`
  sf.addStatements(clsSnippet)
  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, svcIdent)
  ctx.operations.push({
    ruleId,
    engine: CodeModEngineKind.make("ts-morph"),
    action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(clsSnippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const collectSignatureTypesForFn = (
  ctx: ProjectorContext,
  fnNode: EffectFnNode,
): {
  readonly inputType: string
  readonly successType: string
  readonly errorTypes: ReadonlyArray<string>
  readonly serviceTypes: ReadonlyArray<string>
  readonly errorEntityKeys: ReadonlyArray<string>
  readonly serviceEntityKeys: ReadonlyArray<string>
  readonly schemaEntityKeys: ReadonlyArray<string>
} => {
  const fnKey = getNodeKey(fnNode)
  const errorTypes: Array<string> = []
  const serviceTypes: Array<string> = []
  const errorEntityKeys: Array<string> = []
  const serviceEntityKeys: Array<string> = []
  const schemaEntityKeys: Array<string> = []
  let inputSchemaFromEdge: string | undefined
  let outputSchemaFromEdge: string | undefined

  for (const [, edges] of ctx.targetEdgesByRelId.entries()) {
    const isCaller = edges.some((e) => e.role === "caller" && e.entityKey === fnKey)
    if (!isCaller) continue
    for (const e of edges) {
      if (e.role === "fails-with") {
        const name = resolveExportNameForEntityKey(ctx, e.entityKey)
        if (name !== undefined && !errorTypes.includes(name)) {
          errorTypes.push(name)
          errorEntityKeys.push(e.entityKey)
        }
      } else if (e.role === "requires-service") {
        const name = resolveExportNameForEntityKey(ctx, e.entityKey)
        if (name !== undefined && !serviceTypes.includes(name)) {
          serviceTypes.push(name)
          serviceEntityKeys.push(e.entityKey)
        }
      } else if (e.role === "input-schema") {
        const name = resolveExportNameForEntityKey(ctx, e.entityKey)
        if (name !== undefined) {
          inputSchemaFromEdge = name
          schemaEntityKeys.push(e.entityKey)
        }
      } else if (e.role === "output-schema") {
        const name = resolveExportNameForEntityKey(ctx, e.entityKey)
        if (name !== undefined) {
          outputSchemaFromEdge = name
          schemaEntityKeys.push(e.entityKey)
        }
      }
    }
  }

  const inputType =
    fnNode.inputSchema !== undefined
      ? sanitizeIdentifier(fnNode.inputSchema)
      : (inputSchemaFromEdge ?? "unknown")
  const successType =
    fnNode.outputSchema !== undefined
      ? sanitizeIdentifier(fnNode.outputSchema)
      : fnNode.successType !== undefined && fnNode.successType !== "unknown"
        ? sanitizeIdentifier(fnNode.successType)
        : (outputSchemaFromEdge ?? (inputType !== "unknown" ? inputType : "void"))

  return {
    inputType,
    successType,
    errorTypes: errorTypes.sort(),
    serviceTypes: serviceTypes.sort(),
    errorEntityKeys,
    serviceEntityKeys,
    schemaEntityKeys,
  }
}

const ensureCrossFileImportsForEntityKeys = (
  ctx: ProjectorContext,
  fromRelFile: string,
  entityKeys: ReadonlyArray<string>,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  for (const key of entityKeys) {
    const targetFile = resolveFileForEntityKey(ctx, key)
    const exportName = resolveExportNameForEntityKey(ctx, key)
    if (targetFile === undefined || exportName === undefined) continue
    const normTarget = normalizeRelPath(ctx.repoRoot, targetFile)
    if (normTarget === fromRelFile) continue
    const moduleSpec = computeRelativeModuleSpec(fromRelFile, normTarget)
    ensureNamedImport(ctx, fromRelFile, moduleSpec, [exportName], ruleId, rationale)
  }
}

const projectEffectFnNode = (
  ctx: ProjectorContext,
  node: EffectFnNode,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file)
  const fnIdent = sanitizeIdentifier(node.qualname.split("#").pop() ?? node.spanName)
  ensureNamedImport(ctx, norm, "effect", ["Effect", "Schema"], ruleId, rationale)

  const sigInfo = collectSignatureTypesForFn(ctx, node)
  ensureCrossFileImportsForEntityKeys(
    ctx,
    norm,
    [
      ...sigInfo.errorEntityKeys,
      ...sigInfo.serviceEntityKeys,
      ...sigInfo.schemaEntityKeys,
    ],
    ruleId,
    rationale,
  )

  let effectiveInputType = sigInfo.inputType
  if (effectiveInputType === "unknown") {
    const fallbackInputIdent = `${fnIdent}Input`
    if (
      sf.getVariableDeclaration(fallbackInputIdent) === undefined &&
      sf.getTypeAlias(fallbackInputIdent) === undefined
    ) {
      sf.addVariableStatement({
        isExported: true,
        declarationKind: VariableDeclarationKind.Const,
        declarations: [
          {
            name: fallbackInputIdent,
            initializer: `Schema.NonEmptyString.pipe(Schema.brand("${fallbackInputIdent}"))`,
          },
        ],
      })
      sf.addTypeAlias({
        isExported: true,
        name: fallbackInputIdent,
        type: `typeof ${fallbackInputIdent}.Type`,
      })
      recordExportedSymbol(ctx, norm, fallbackInputIdent)
    }
    effectiveInputType = fallbackInputIdent
  }

  const effectiveSuccessType =
    sigInfo.successType === "void" || sigInfo.successType === "unknown"
      ? effectiveInputType
      : sigInfo.successType
  const eChannel = sigInfo.errorTypes.length > 0 ? sigInfo.errorTypes.join(" | ") : "never"
  const rChannel = sigInfo.serviceTypes.length > 0 ? sigInfo.serviceTypes.join(" | ") : "never"

  if (node.isStub === true && sf.getVariableDeclaration("stub") === undefined) {
    const hasStubImport = sf
      .getImportDeclarations()
      .some((d) => d.getNamedImports().some((n) => n.getName() === "stub"))
    if (!hasStubImport) {
      ensureNamedImport(ctx, norm, "@harness/gates", ["stub"], ruleId, rationale)
    }
  }

  const existingVar = sf.getVariableDeclaration(fnIdent)
  const catchSuffix =
    node.caughtErrors !== undefined && node.caughtErrors.length > 0
      ? node.caughtErrors.map((tag) => `.pipe(Effect.catchTag("${tag}", () => Effect.succeed(input)))`).join("")
      : ""

  const bodyStatement =
    catchSuffix.length > 0
      ? (node.isStub === true
          ? `return yield* stub<${effectiveSuccessType}, ${eChannel}, ${rChannel}>(input)${catchSuffix}`
          : `return yield* Effect.succeed(input)${catchSuffix}`)
      : (node.isStub === true
          ? `return yield* stub<${effectiveSuccessType}, ${eChannel}, ${rChannel}>(input)`
          : `return input`)

  const fnInitializer = `Effect.fn("${node.spanName}")(function* (\n  input: ${effectiveInputType},\n): Effect.fn.Return<${effectiveSuccessType}, ${eChannel}, ${rChannel}> {\n  ${bodyStatement}\n})`
  const fullSnippet = `export const ${fnIdent} = ${fnInitializer}`

  if (existingVar !== undefined) {
    existingVar.setInitializer(fnInitializer)
    ctx.modifiedFiles.add(norm)
    recordExportedSymbol(ctx, norm, fnIdent)
    ctx.operations.push({
      ruleId,
      engine: CodeModEngineKind.make("ts-morph"),
      action: CodeModActionKind.make("update-signature"),
      targetFile: TargetFilePath.make(norm),
      targetSymbol: NodeKey.make(getNodeKey(node)),
      snippet: TypeScriptSnippet.make(fullSnippet),
      rationale: SpecificationRef.make(rationale),
    })
    return
  }

  sf.addStatements(fullSnippet)
  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, fnIdent)
  ctx.operations.push({
    ruleId,
    engine: CodeModEngineKind.make("ts-morph"),
    action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(fullSnippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const projectServiceLayerNode = (
  ctx: ProjectorContext,
  node: ServiceLayerNode,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file)
  const layerIdent = sanitizeIdentifier((node.qualname ?? "").split("#").pop() ?? "SynthesizedLive")
  ensureNamedImport(ctx, norm, "effect", ["Effect", "Layer"], ruleId, rationale)

  const layerKey = getNodeKey(node)
  const providedServiceKeys: Array<string> = []
  const requiredServiceKeys: Array<string> = []

  for (const [, edges] of ctx.targetEdgesByRelId.entries()) {
    const isProvider = edges.some((e) => e.role === "provider-layer" && e.entityKey === layerKey)
    if (!isProvider) continue
    for (const e of edges) {
      if (e.role === "provided-service") {
        providedServiceKeys.push(e.entityKey)
      } else if (e.role === "required-service") {
        requiredServiceKeys.push(e.entityKey)
      }
    }
  }

  ensureCrossFileImportsForEntityKeys(
    ctx,
    norm,
    [...providedServiceKeys, ...requiredServiceKeys],
    ruleId,
    rationale,
  )

  const providedNames = providedServiceKeys
    .map((k) => resolveExportNameForEntityKey(ctx, k))
    .filter((n): n is string => n !== undefined)
  const requiredNames = requiredServiceKeys
    .map((k) => resolveExportNameForEntityKey(ctx, k))
    .filter((n): n is string => n !== undefined)

  const primaryProvided = providedNames[0] ?? "never"
  const rOut = providedNames.length > 0 ? providedNames.join(" | ") : "never"
  const rIn = requiredNames.length > 0 ? requiredNames.join(" | ") : "never"

  const existingVar = sf.getVariableDeclaration(layerIdent)
  const yieldRequiredLines = requiredNames.map((req) => `  yield* ${req}`).join("\n")
  const layerInit =
    primaryProvided !== "never"
      ? requiredNames.length > 0
        ? `Layer.effect(\n  ${primaryProvided},\n  Effect.gen(function* () {\n${yieldRequiredLines}\n    return ${primaryProvided}.of({\n      execute: () => Effect.void,\n    })\n  }),\n)`
        : `Layer.effect(\n  ${primaryProvided},\n  Effect.sync(() => ${primaryProvided}.of({\n    execute: () => Effect.void,\n  })),\n)`
      : `Layer.empty`

  const declSnippet = `export const ${layerIdent}: Layer.Layer<${rOut}, never, ${rIn}> = ${layerInit}`

  if (existingVar !== undefined) {
    existingVar.setType(`Layer.Layer<${rOut}, never, ${rIn}>`)
    existingVar.setInitializer(layerInit)
    ctx.modifiedFiles.add(norm)
    recordExportedSymbol(ctx, norm, layerIdent)
    ctx.operations.push({
      ruleId,
      engine: CodeModEngineKind.make("ts-morph"),
      action: CodeModActionKind.make("update-signature"),
      targetFile: TargetFilePath.make(norm),
      targetSymbol: NodeKey.make(layerKey),
      snippet: TypeScriptSnippet.make(declSnippet),
      rationale: SpecificationRef.make(rationale),
    })
    return
  }

  sf.addStatements(declSnippet)
  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, layerIdent)
  ctx.operations.push({
    ruleId,
    engine: CodeModEngineKind.make("ts-morph"),
    action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: NodeKey.make(layerKey),
    snippet: TypeScriptSnippet.make(declSnippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const projectVitestCaseNode = (
  ctx: ProjectorContext,
  node: VitestCaseNode,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.testFile)
  if (sf.getFullText().includes(node.testName)) {
    return
  }

  ensureNamedImport(ctx, norm, "@effect/vitest", ["describe", "expect", "it"], ruleId, rationale)
  ensureNamedImport(ctx, norm, "effect", ["Effect", "Schema"], ruleId, rationale)

  const testKey = getNodeKey(node)
  const exercisedFnKeys: Array<string> = []
  for (const [, edges] of ctx.targetEdgesByRelId.entries()) {
    const hasTest = edges.some(
      (e) =>
        (e.role === "verifying-test" || e.role === "exercising-test") && e.entityKey === testKey,
    )
    if (!hasTest) continue
    for (const e of edges) {
      if (e.role === "realizing-symbol" || e.role === "exercised-span") {
        if (e.entityKey.startsWith("EffectFn:")) {
          exercisedFnKeys.push(e.entityKey)
        }
      }
    }
  }

  ensureCrossFileImportsForEntityKeys(ctx, norm, exercisedFnKeys, ruleId, rationale)
  const exercisedFnNames = exercisedFnKeys
    .map((k) => resolveExportNameForEntityKey(ctx, k))
    .filter((n): n is string => n !== undefined)
  const callComment =
    exercisedFnNames.length > 0 ? `      void ${exercisedFnNames[0]}\n` : ""

  const testSnippet = `describe("${node.testName}", () => {\n  it.effect.prop(\n    "${node.testName}",\n    { value: Schema.NonEmptyString },\n    ({ value }: { readonly value: string }) =>\n      Effect.gen(function* () {\n${callComment}        expect(value.length).toBeGreaterThan(0)\n      }),\n  )\n})`
  sf.addStatements(testSnippet)
  ctx.modifiedFiles.add(norm)
  ctx.operations.push({
    ruleId,
    engine: CodeModEngineKind.make("ts-morph"),
    action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: NodeKey.make(testKey),
    snippet: TypeScriptSnippet.make(testSnippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const projectMigrationTupleRelation = (
  ctx: ProjectorContext,
  rel: MigrationTupleRelation,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, rel.moduleFile)
  const fullText = sf.getFullText()
  if (fullText.includes("SqliteMigrator.fromRecord") && fullText.includes(rel.migrationId)) {
    return
  }

  ensureNamedImport(ctx, norm, "effect", ["Effect"], ruleId, rationale)
  ensureNamedImport(
    ctx,
    norm,
    "@effect/sql-sqlite-do",
    ["SqliteClient", "SqliteMigrator"],
    ruleId,
    rationale,
  )

  // Use @ast-grep/napi to locate any raw sql`CREATE TABLE ...` or sql`ALTER TABLE ...` expressions
  const rootNode = parse(Lang.TypeScript, sf.getFullText()).root()
  const rawSqlMatches = rootNode
    .findAll("sql`$DDL`")
    .filter((m) => /\b(?:CREATE|ALTER)\s+TABLE\b/i.test(m.text()))

  const ddlBody =
    rawSqlMatches.length > 0
      ? rawSqlMatches[0]!.text()
      : "sql`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY)`"

  const migrationSnippet = `export const migrations = SqliteMigrator.fromRecord({\n  "${rel.migrationId}": Effect.gen(function* () {\n    const sql = yield* SqliteClient.SqliteClient\n    yield* ${ddlBody}\n  }),\n})`

  if (rawSqlMatches.length > 0) {
    const updatedText = sf
      .getFullText()
      .replace(rawSqlMatches[0]!.text(), "Effect.void")
    sf.replaceWithText(`${updatedText.trimEnd()}\n\n${migrationSnippet}\n`)
  } else {
    sf.addStatements(migrationSnippet)
  }

  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, "migrations")
  ctx.operations.push({
    ruleId,
    engine: CodeModEngineKind.make("ast-grep"),
    action: CodeModActionKind.make("replace-expression"),
    targetFile: TargetFilePath.make(norm),
    targetRelation: rel.relationId,
    snippet: TypeScriptSnippet.make(migrationSnippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const applyRep05UntracedDeciderRepair = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  rationale: string,
): void => {
  for (const insEnt of patch.insertedEntityNodes) {
    match(insEnt)
      .with({ _tag: "EffectFn" }, (fnEnt) => {
        const { sf, norm } = getOrCreateSourceFile(ctx, fnEnt.file)
        const fnIdent = sanitizeIdentifier(fnEnt.qualname.split("#").pop() ?? fnEnt.spanName)
        ensureNamedImport(ctx, norm, "effect", ["Effect"], patch.ruleId, rationale)

        const varDecl = sf.getVariableDeclaration(fnIdent)
        if (varDecl !== undefined) {
          const init = varDecl.getInitializer()
          if (init !== undefined) {
            const initText = init.getText()
            if (initText.startsWith("Effect.fnUntraced")) {
              const nextInit = initText.replace(
                /^Effect\.fnUntraced/,
                `Effect.fn("${fnEnt.spanName}")`,
              )
              varDecl.setInitializer(nextInit)
              ctx.modifiedFiles.add(norm)
              recordExportedSymbol(ctx, norm, fnIdent)
              ctx.operations.push({
                ruleId: patch.ruleId,
                engine: CodeModEngineKind.make("ast-grep"),
                action: CodeModActionKind.make("replace-expression"),
                targetFile: TargetFilePath.make(norm),
                targetSymbol: NodeKey.make(getNodeKey(fnEnt)),
                snippet: TypeScriptSnippet.make(`export const ${fnIdent} = ${nextInit}`),
                rationale: SpecificationRef.make(rationale),
              })
              return
            }
            if (!initText.startsWith("Effect.fn(")) {
              const nextInit = `Effect.fn("${fnEnt.spanName}")(${initText})`
              varDecl.setInitializer(nextInit)
              ctx.modifiedFiles.add(norm)
              recordExportedSymbol(ctx, norm, fnIdent)
              ctx.operations.push({
                ruleId: patch.ruleId,
                engine: CodeModEngineKind.make("ast-grep"),
                action: CodeModActionKind.make("replace-expression"),
                targetFile: TargetFilePath.make(norm),
                targetSymbol: NodeKey.make(getNodeKey(fnEnt)),
                snippet: TypeScriptSnippet.make(`export const ${fnIdent} = ${nextInit}`),
                rationale: SpecificationRef.make(rationale),
              })
              return
            }
          }
        }
      })
      .with(
        { _tag: "SchemaDef" },
        { _tag: "TaggedError" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        () => undefined,
      )
      .exhaustive()
  }
}

const applyRep07DiscriminantMatchRepair = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  rationale: string,
): void => {
  const rawKey = String(patch.primaryNodeKey).replace(/^EffectFn:/, "")
  const filePart = rawKey.split("#")[0] ?? "libs/domain/src/repaired.ts"
  const { sf, norm } = getOrCreateSourceFile(ctx, filePart)
  ensureNamedImport(ctx, norm, "ts-pattern", ["match"], patch.ruleId, rationale)

  const sourceText = sf.getFullText()
  const root = parse(Lang.TypeScript, sourceText).root()

  // 1. Rewrite `if ($X._tag === $TAG) { return $A } else { return $B }` or `switch ($X._tag)` via @ast-grep/napi + ts-morph
  const ifMatches = root.findAll("if ($COND) { $$$THEN } else { $$$ELSE }")
  let rewrittenSnippet: string | undefined

  for (const m of ifMatches) {
    const text = m.text()
    if (
      text.includes("._tag") ||
      text.includes("Option.isSome") ||
      text.includes("Option.isNone") ||
      text.includes("Result.isSuccess")
    ) {
      const condNode = m.getMatch("COND")
      const condText = condNode?.text() ?? ""
      const tagMatch = condText.match(/([A-Za-z0-9_$.]+)\._tag\s*===\s*["']([^"']+)["']/)
      if (tagMatch && tagMatch[1] && tagMatch[2]) {
        const subject = tagMatch[1]
        const literalTag = tagMatch[2]
        const thenNodes = m.getMultipleMatches("THEN")
        const elseNodes = m.getMultipleMatches("ELSE")
        const thenRaw = thenNodes.map((n) => n.text()).join(" ").trim()
        const elseRaw = elseNodes.map((n) => n.text()).join(" ").trim()
        const thenRet =
          thenRaw.match(/^return\s+(.+?);?$/)?.[1]?.trim() ?? (thenRaw.length > 0 ? thenRaw : "true")
        const elseRet =
          elseRaw.match(/^return\s+(.+?);?$/)?.[1]?.trim() ?? (elseRaw.length > 0 ? elseRaw : "false")
        ensureNamedImport(ctx, norm, "ts-pattern", ["match", "P"], patch.ruleId, rationale)
        const replacement =
          elseRaw.length > 0
            ? `return match(${subject}).with({ _tag: "${literalTag}" }, () => ${thenRet}).with(P._, () => ${elseRet}).exhaustive()`
            : `return match(${subject}).with({ _tag: "${literalTag}" }, () => ${thenRet}).exhaustive()`
        sf.replaceWithText(sourceText.replace(text, replacement))
        rewrittenSnippet = replacement
        break
      }
    }
  }

  if (rewrittenSnippet === undefined) {
    // Also inspect ts-morph SwitchStatements on `._tag` or `.kind`
    for (const sw of sf.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
      const exprText = sw.getExpression().getText()
      if (exprText.endsWith("._tag") || exprText.endsWith(".kind")) {
        const subject = exprText.replace(/\.(?:_tag|kind)$/, "")
        const prop = exprText.endsWith(".kind") ? "kind" : "_tag"
        const arms: Array<string> = []
        for (const clause of sw.getCaseBlock().getClauses()) {
          if (Node.isCaseClause(clause)) {
            const caseVal = clause.getExpression().getText()
            const retStmt = clause.getStatements().find(Node.isReturnStatement)
            const retExpr = retStmt?.getExpression()?.getText() ?? "undefined"
            arms.push(`.with({ ${prop}: ${caseVal} }, () => ${retExpr})`)
          }
        }
        const replacement = `return match(${subject})${arms.join("")}.exhaustive()`
        sw.replaceWithText(replacement)
        rewrittenSnippet = replacement
        break
      }
    }
  }

  if (rewrittenSnippet === undefined) {
    // Replace `.otherwise(...)` with `.exhaustive()` on closed union matches via balanced paren scanning
    const fullNow = sf.getFullText()
    if (fullNow.includes(".otherwise(")) {
      let result = fullNow
      while (true) {
        const target = ".otherwise("
        const idx = result.indexOf(target)
        if (idx === -1) break
        const openParenIdx = idx + target.length - 1
        let depth = 1
        let closeParenIdx = -1
        for (let i = openParenIdx + 1; i < result.length; i++) {
          const ch = result[i]
          if (ch === "(") {
            depth++
          } else if (ch === ")") {
            depth--
            if (depth === 0) {
              closeParenIdx = i
              break
            }
          }
        }
        if (closeParenIdx === -1) break
        result = result.slice(0, idx) + ".exhaustive()" + result.slice(closeParenIdx + 1)
      }
      sf.replaceWithText(result)
      rewrittenSnippet = "match(...).exhaustive()"
    } else {
      rewrittenSnippet = "match(value).exhaustive()"
    }
  }

  ctx.modifiedFiles.add(norm)
  ctx.operations.push({
    ruleId: patch.ruleId,
    engine: CodeModEngineKind.make("ast-grep"),
    action: CodeModActionKind.make("replace-expression"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: patch.primaryNodeKey,
    snippet: TypeScriptSnippet.make(rewrittenSnippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const applyRep08DecodeBoundaryRepair = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  rationale: string,
): void => {
  for (const insEnt of patch.insertedEntityNodes) {
    match(insEnt)
      .with({ _tag: "TaggedError" }, (errEnt) =>
        projectTaggedErrorNode(ctx, errEnt, patch.ruleId, rationale),
      )
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        () => undefined,
      )
      .exhaustive()
  }
  const rawKey = String(patch.primaryNodeKey).replace(/^EffectFn:/, "")
  const filePart = rawKey.split("#")[0] ?? "libs/infra/src/repaired.ts"
  const { sf, norm } = getOrCreateSourceFile(ctx, filePart)
  ensureNamedImport(ctx, norm, "effect", ["Effect", "Schema"], patch.ruleId, rationale)

  const root = parse(Lang.TypeScript, sf.getFullText()).root()
  const makeMatches = root.findAll("$BRAND.make($ARG)")
  let snippet = "yield* Schema.decodeUnknownEffect(TargetSchema)(rawValue)"

  if (makeMatches.length > 0) {
    const first = makeMatches[0]!
    const brandName = first.getMatch("BRAND")?.text() ?? "TargetSchema"
    const argText = first.getMatch("ARG")?.text() ?? "rawValue"
    const matchText = first.text()
    const matchIdx = sf.getFullText().indexOf(matchText)
    const nodeAtPos = matchIdx !== -1 ? sf.getDescendantAtPos(matchIdx) : undefined

    let isGenerator = false
    let current = nodeAtPos
    while (current !== undefined) {
      if (
        (Node.isFunctionDeclaration(current) || Node.isFunctionExpression(current)) &&
        current.isGenerator()
      ) {
        isGenerator = true
        break
      }
      current = current.getParent()
    }

    snippet = isGenerator
      ? `yield* Schema.decodeUnknownEffect(${brandName})(${argText})`
      : `Effect.runSync(Schema.decodeUnknownEffect(${brandName})(${argText}))`

    sf.replaceWithText(sf.getFullText().replace(matchText, snippet))
  }

  ctx.modifiedFiles.add(norm)
  ctx.operations.push({
    ruleId: patch.ruleId,
    engine: CodeModEngineKind.make("ast-grep"),
    action: CodeModActionKind.make("replace-expression"),
    targetFile: TargetFilePath.make(norm),
    targetSymbol: patch.primaryNodeKey,
    snippet: TypeScriptSnippet.make(snippet),
    rationale: SpecificationRef.make(rationale),
  })
}

const applyRep11DeleteUnusedService = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  initialGraph?: HarnessGraph,
  rationale: string = "harness:SPEC-0008",
): void => {
  for (const delKey of patch.deletedEntityKeys) {
    let targetFile = "libs/service/src/ports.ts"
    let svcIdent = sanitizeIdentifier(String(delKey).replace(/^ServiceTag:/, ""))
    if (initialGraph !== undefined) {
      const idx = initialGraph.nodeIndexByKey.get(delKey)
      if (idx !== undefined) {
        const nodeOpt = Graph.getNode(initialGraph.graph, idx)
        match(nodeOpt)
          .with({ _tag: "Some" }, ({ value }) => {
            match(value)
              .with({ _tag: "ServiceTag" }, (svc) => {
                targetFile = svc.file
                svcIdent = sanitizeIdentifier(svc.name)
              })
              .with(
                { _tag: "EffectFn" },
                { _tag: "ServiceLayer" },
                { _tag: "TaggedError" },
                { _tag: "SchemaDef" },
                { _tag: "VitestCase" },
                { _tag: "PatternDoc" },
                { _tag: "AdrDoc" },
                { _tag: "EarsSpec" },
                { _tag: "EffectSignature" },
                { _tag: "LayerFlow" },
                { _tag: "TraceabilityTuple" },
                { _tag: "HttpEndpointTuple" },
                { _tag: "MigrationTuple" },
                () => undefined,
              )
              .exhaustive()
          })
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
      }
    }
    const { sf, norm } = getOrCreateSourceFile(ctx, targetFile)
    const cls = sf.getClass(svcIdent)
    if (cls !== undefined) {
      cls.remove()
    }
    const varDecl = sf.getVariableDeclaration(svcIdent)
    if (varDecl !== undefined) {
      varDecl.getVariableStatement()?.remove()
    }
    ctx.modifiedFiles.add(norm)
    ctx.operations.push({
      ruleId: patch.ruleId,
      engine: CodeModEngineKind.make("ts-morph"),
      action: CodeModActionKind.make("remove-declaration"),
      targetFile: TargetFilePath.make(norm),
      targetSymbol: delKey,
      snippet: TypeScriptSnippet.make(`// Removed unused ServiceTag ${svcIdent}`),
      rationale: SpecificationRef.make(rationale),
    })
  }
}

/**
 * Mandatory co-projection of Nx barrel files (`libs/<scope>/<tier>/src/index.ts` or `libs/<tier>/src/index.ts`)
 * whenever an exported symbol is added to `src/*.ts` (`RFC-0004 §4.3`).
 */
const coProjectBarrelExports = (
  ctx: ProjectorContext,
  ruleId: RewriteRuleId,
  rationale: string,
): void => {
  for (const [relFile, exportedSymbols] of ctx.exportedSymbolsByFile.entries()) {
    if (exportedSymbols.size === 0) continue
    if (
      relFile.endsWith("/index.ts") ||
      relFile.endsWith("/index.tsx") ||
      relFile.includes("/test/") ||
      relFile.endsWith(".test.ts") ||
      relFile.endsWith(".test.tsx") ||
      relFile.endsWith(".spec.ts") ||
      relFile.endsWith(".spec.tsx")
    ) {
      continue
    }

    const scopedMatch = relFile.match(
      /^(libs\/[^/]+\/(?:contract|service|domain|core|infra)\/src)\/(.+)\.(?:ts|tsx)$/,
    )
    const flatMatch = relFile.match(
      /^(libs\/(?:contract|service|domain|core|infra)\/src)\/(.+)\.(?:ts|tsx)$/,
    )
    const baseSrcDir = scopedMatch?.[1] ?? flatMatch?.[1]
    const subModulePath = scopedMatch?.[2] ?? flatMatch?.[2]
    if (baseSrcDir === undefined || subModulePath === undefined || subModulePath === "index") {
      continue
    }

    const barrelRelPath = `${baseSrcDir}/index.ts`
    const moduleSpecifier = `./${subModulePath}.js`
    const { sf: barrelSf, norm: barrelNorm } = getOrCreateSourceFile(ctx, barrelRelPath)

    // Check if `export * from "./<subModulePath>.js"` already exists
    const existingExportDecls = barrelSf.getExportDeclarations()
    const hasWildcardReExport = existingExportDecls.some(
      (d) =>
        (d.getModuleSpecifierValue() === moduleSpecifier ||
          d.getModuleSpecifierValue() === `./${subModulePath}.ts`) &&
        !d.hasNamedExports() &&
        !d.isNamespaceExport(),
    )
    if (hasWildcardReExport) {
      continue
    }

    const existingNamedDecl = existingExportDecls.find(
      (d) =>
        (d.getModuleSpecifierValue() === moduleSpecifier ||
          d.getModuleSpecifierValue() === `./${subModulePath}.ts`) &&
        d.hasNamedExports(),
    )
    const sortedSymbols = Array.from(exportedSymbols).sort()
    const newlyExported: Array<string> = []

    if (existingNamedDecl !== undefined) {
      const currentExported = new Set(existingNamedDecl.getNamedExports().map((e) => e.getName()))
      for (const sym of sortedSymbols) {
        if (!currentExported.has(sym)) {
          existingNamedDecl.addNamedExport(sym)
          newlyExported.push(sym)
        }
      }
    } else {
      barrelSf.addExportDeclaration({
        moduleSpecifier,
        namedExports: sortedSymbols,
      })
      newlyExported.push(...sortedSymbols)
    }

    if (newlyExported.length > 0) {
      ctx.modifiedFiles.add(barrelNorm)
      ctx.operations.push({
        ruleId,
        engine: CodeModEngineKind.make("ts-morph"),
        action: CodeModActionKind.make("insert-declaration"),
        targetFile: TargetFilePath.make(barrelNorm),
        snippet: TypeScriptSnippet.make(
          `export { ${newlyExported.join(", ")} } from "${moduleSpecifier}"`,
        ),
        rationale: SpecificationRef.make(rationale),
      })
    }
  }
}

const projectPatchesToInMemoryWorkspace = (
  repoRoot: string,
  targetGraph: HarnessGraph,
  patches: ReadonlyArray<GraphPatch>,
  initialGraph?: HarnessGraph,
  existingFiles?: Readonly<Record<string, string>>,
): {
  readonly operations: ReadonlyArray<AstCodeModOperation>
  readonly overlays: ReadonlyArray<ShadowFileOverlay>
  readonly overlayMap: Readonly<Record<string, string>>
} => {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
    },
  })

  const initialContents = new Map<string, string>()
  if (existingFiles !== undefined) {
    for (const [k, v] of Object.entries(existingFiles)) {
      const norm = normalizeRelPath(repoRoot, k)
      initialContents.set(norm, v)
    }
  }

  const targetEntitiesByKey = new Map<string, EntityNode>()
  const targetRelationsById = new Map<string, RelationNode>()
  const targetEdgesByRelId = new Map<string, Array<PlaysRoleEdge>>()

  for (const [, node] of Graph.nodes(targetGraph.graph)) {
    const key = getNodeKey(node)
    if ("relationId" in node) {
      targetRelationsById.set(node.relationId, node)
      targetRelationsById.set(key, node)
    } else {
      targetEntitiesByKey.set(key, node)
    }
  }

  for (const [, edge] of Graph.edges(targetGraph.graph)) {
    const relId = edge.data.relationId
    let list = targetEdgesByRelId.get(relId)
    if (list === undefined) {
      list = []
      targetEdgesByRelId.set(relId, list)
    }
    list.push(edge.data)
  }

  // Also index inserted entities/relations/edges from patches in case targetGraph is partial
  for (const p of patches) {
    for (const ent of p.insertedEntityNodes) {
      targetEntitiesByKey.set(getNodeKey(ent), ent)
    }
    for (const rel of p.insertedRelationNodes) {
      targetRelationsById.set(rel.relationId, rel)
      targetRelationsById.set(getNodeKey(rel), rel)
    }
    for (const edge of p.insertedRoleEdges) {
      let list = targetEdgesByRelId.get(edge.relationId)
      if (list === undefined) {
        list = []
        targetEdgesByRelId.set(edge.relationId, list)
      }
      if (!list.some((e) => e.role === edge.role && e.entityKey === edge.entityKey)) {
        list.push(edge)
      }
    }
  }

  // Pre-populate initial contents from disk for any touched file
  const candidateFiles = new Set<string>()
  for (const ent of targetEntitiesByKey.values()) {
    match(ent)
      .with({ _tag: "EffectFn" }, (n) => candidateFiles.add(n.file))
      .with({ _tag: "ServiceTag" }, (n) => candidateFiles.add(n.file))
      .with({ _tag: "ServiceLayer" }, (n) => candidateFiles.add(n.file))
      .with({ _tag: "TaggedError" }, (n) => candidateFiles.add(n.file))
      .with({ _tag: "SchemaDef" }, (n) => candidateFiles.add(n.file))
      .with({ _tag: "VitestCase" }, (n) => candidateFiles.add(n.testFile))
      .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, () => undefined)
      .exhaustive()
  }
  for (const rel of targetRelationsById.values()) {
    match(rel)
      .with({ _tag: "MigrationTuple" }, (r) => candidateFiles.add(r.moduleFile))
      .with({ _tag: "EffectSignature" }, { _tag: "LayerFlow" }, (r) => candidateFiles.add(r.file))
      .with({ _tag: "TraceabilityTuple" }, { _tag: "HttpEndpointTuple" }, () => undefined)
      .exhaustive()
  }
  for (const f of candidateFiles) {
    const norm = normalizeRelPath(repoRoot, f)
    if (!initialContents.has(norm)) {
      const diskContent = readInitialFileContent(repoRoot, norm, existingFiles)
      if (diskContent !== undefined) {
        initialContents.set(norm, diskContent)
      }
    }
    const barrelMatch = norm.match(
      /^(libs\/(?:[^/]+\/)?(?:contract|service|domain|core|infra)\/src)\//,
    )
    if (barrelMatch?.[1] !== undefined) {
      const barrelRel = `${barrelMatch[1]}/index.ts`
      if (!initialContents.has(barrelRel)) {
        const diskBarrel = readInitialFileContent(repoRoot, barrelRel, existingFiles)
        if (diskBarrel !== undefined) {
          initialContents.set(barrelRel, diskBarrel)
        }
      }
    }
  }

  const ctx: ProjectorContext = {
    repoRoot,
    project,
    initialContents,
    modifiedFiles: new Set<string>(),
    exportedSymbolsByFile: new Map<string, Set<string>>(),
    operations: [],
    targetEntitiesByKey,
    targetRelationsById,
    targetEdgesByRelId,
  }

  for (const patch of patches) {
    const rationale = `harness:SPEC-0008 (${patch.ruleId})`

    if (patch.ruleId === "REP-05") {
      applyRep05UntracedDeciderRepair(ctx, patch, rationale)
      continue
    }
    if (patch.ruleId === "REP-07") {
      applyRep07DiscriminantMatchRepair(ctx, patch, rationale)
      continue
    }
    if (patch.ruleId === "REP-08") {
      applyRep08DecodeBoundaryRepair(ctx, patch, rationale)
      continue
    }
    if (patch.ruleId === "REP-11") {
      applyRep11DeleteUnusedService(ctx, patch, initialGraph, rationale)
      continue
    }

    // 1. Project SchemaDef, TaggedError, and ServiceTag nodes first so types exist before functions/layers
    for (const insEnt of patch.insertedEntityNodes) {
      match(insEnt)
        .with({ _tag: "SchemaDef" }, (n) => projectSchemaDefNode(ctx, n, patch.ruleId, rationale))
        .with({ _tag: "TaggedError" }, (n) =>
          projectTaggedErrorNode(ctx, n, patch.ruleId, rationale),
        )
        .with({ _tag: "ServiceTag" }, (n) => projectServiceTagNode(ctx, n, patch.ruleId, rationale))
        .with(
          { _tag: "EffectFn" },
          { _tag: "ServiceLayer" },
          { _tag: "VitestCase" },
          { _tag: "PatternDoc" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          () => undefined,
        )
        .exhaustive()
    }

    // 2. Project EffectFn, ServiceLayer, and VitestCase nodes
    for (const insEnt of patch.insertedEntityNodes) {
      match(insEnt)
        .with({ _tag: "EffectFn" }, (n) => projectEffectFnNode(ctx, n, patch.ruleId, rationale))
        .with({ _tag: "ServiceLayer" }, (n) =>
          projectServiceLayerNode(ctx, n, patch.ruleId, rationale),
        )
        .with({ _tag: "VitestCase" }, (n) =>
          projectVitestCaseNode(ctx, n, patch.ruleId, rationale),
        )
        .with(
          { _tag: "SchemaDef" },
          { _tag: "TaggedError" },
          { _tag: "ServiceTag" },
          { _tag: "PatternDoc" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          () => undefined,
        )
        .exhaustive()
    }

    // 3. Project updated existing callers if PlaysRoleEdges were attached/deleted in K
    const touchedCallerKeys = new Set<string>()
    for (const edge of [...patch.insertedRoleEdges, ...patch.deletedRoleEdges]) {
      const relEdges = ctx.targetEdgesByRelId.get(edge.relationId) ?? []
      for (const re of relEdges) {
        if (re.role === "caller") {
          touchedCallerKeys.add(re.entityKey)
        }
      }
    }
    for (const callerKey of touchedCallerKeys) {
      const callerEnt = ctx.targetEntitiesByKey.get(callerKey)
      if (
        callerEnt !== undefined &&
        !patch.insertedEntityNodes.some((n) => getNodeKey(n) === callerKey)
      ) {
        match(callerEnt)
          .with({ _tag: "EffectFn" }, (fnEnt) =>
            projectEffectFnNode(ctx, fnEnt, patch.ruleId, rationale),
          )
          .with(
            { _tag: "ServiceTag" },
            { _tag: "ServiceLayer" },
            { _tag: "TaggedError" },
            { _tag: "SchemaDef" },
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            () => undefined,
          )
          .exhaustive()
      }
    }

    // 4. Project MigrationTuple relations (REP-09)
    for (const insRel of patch.insertedRelationNodes) {
      match(insRel)
        .with({ _tag: "MigrationTuple" }, (migRel) =>
          projectMigrationTupleRelation(ctx, migRel, patch.ruleId, rationale),
        )
        .with(
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          () => undefined,
        )
        .exhaustive()
    }

    // 5. Co-project Nx barrel files (`src/index.ts`)
    coProjectBarrelExports(ctx, patch.ruleId, rationale)
  }

  const overlays: Array<ShadowFileOverlay> = []
  const overlayMap: Record<string, string> = {}
  const sortedModified = Array.from(ctx.modifiedFiles).sort()
  for (const relFile of sortedModified) {
    const sf = ctx.project.getSourceFile(`/${relFile}`)
    if (sf === undefined) continue
    const content = sf.getFullText()
    overlays.push({
      targetFile: TargetFilePath.make(relFile),
      content: TypeScriptSnippet.make(content),
    })
    overlayMap[relFile] = content
  }

  return {
    operations: ctx.operations,
    overlays,
    overlayMap,
  }
}

interface BatchVerificationOutcome {
  readonly isClean: boolean
  readonly diagnostics: ReadonlyArray<string>
}

const verifyProjectedSubset = (
  repoRoot: string,
  baseGraph: HarnessGraph | undefined,
  fallbackTargetGraph: HarnessGraph,
  subsetPatches: ReadonlyArray<GraphPatch>,
  overlayMap: Readonly<Record<string, string>>,
  existingFiles?: Readonly<Record<string, string>>,
  forceFailRuleIds?: ReadonlySet<string>,
): Effect.Effect<BatchVerificationOutcome, never, never> =>
  Effect.gen(function* () {
    if (subsetPatches.length === 0) {
      return { isClean: true, diagnostics: [] }
    }

    if (forceFailRuleIds !== undefined && forceFailRuleIds.size > 0) {
      const forced = subsetPatches.find((p) => forceFailRuleIds.has(p.ruleId))
      if (forced !== undefined) {
        return {
          isClean: false,
          diagnostics: [`Forced verification failure for rule '${forced.ruleId}'.`],
        }
      }
    }

    const combinedOverlays: Record<string, string> = {
      ...existingFiles,
      ...overlayMap,
    }

    const session = getOrCreateWarmProgramSession(repoRoot)
    const compilerDiags = evaluateOverlayDiagnostics(repoRoot, combinedOverlays, session)
    const errorDiags = compilerDiags
      .filter((d) => d.severity === "error")
      .map((d) => `${d.file}:${d.line}:${d.column} ${d.code}: ${d.message}`)

    // Build source inputs from combinedOverlays to verify Round-Trip Commutativity Law
    const sourceInputs: Array<SourceFileInput> = []
    for (const [relFile, content] of Object.entries(combinedOverlays)) {
      const norm = normalizeRelPath(repoRoot, relFile)
      if (norm.includes("/test/") || norm.endsWith(".test.ts") || norm.endsWith(".spec.ts")) {
        continue
      }
      sourceInputs.push({
        filePath: norm,
        content,
        packageTag: resolvePackageTag(repoRoot, norm),
      })
    }

    const extractedOverlayGraph = extractTypeAwareGraphFromSource(sourceInputs, {
      repoRoot,
      overlays: combinedOverlays,
      session: undefined,
    })

    // Compute expected subgraph H for this subset of patches
    let expectedGraph = baseGraph
    if (expectedGraph !== undefined) {
      for (const patch of subsetPatches) {
        const stepped = yield* Effect.exit(applyDpoPatchToGraph(expectedGraph, patch))
        const shouldContinue = match(stepped)
          .with({ _tag: "Success" }, (s) => {
            expectedGraph = s.value
            return true
          })
          .with({ _tag: "Failure" }, () => {
            expectedGraph = fallbackTargetGraph
            return false
          })
          .exhaustive()
        if (!shouldContinue) {
          break
        }
      }
    } else {
      expectedGraph = fallbackTargetGraph
    }

    const requiredEntityKeys = new Set<string>()
    const requiredRelationIds = new Set<string>()
    const requiredRoleEdges: Array<PlaysRoleEdge> = []

    for (const p of subsetPatches) {
      for (const ent of p.insertedEntityNodes) {
        match(ent)
          .with(
            { _tag: "SchemaDef" },
            { _tag: "TaggedError" },
            { _tag: "ServiceTag" },
            { _tag: "EffectFn" },
            { _tag: "ServiceLayer" },
            (n) => {
              requiredEntityKeys.add(getNodeKey(n))
            },
          )
          .with(
            { _tag: "VitestCase" },
            { _tag: "PatternDoc" },
            { _tag: "AdrDoc" },
            { _tag: "EarsSpec" },
            () => undefined,
          )
          .exhaustive()
      }
      for (const rel of p.insertedRelationNodes) {
        match(rel)
          .with({ _tag: "MigrationTuple" }, (r) => {
            requiredRelationIds.add(r.relationId)
          })
          .with(
            { _tag: "EffectSignature" },
            { _tag: "LayerFlow" },
            { _tag: "TraceabilityTuple" },
            { _tag: "HttpEndpointTuple" },
            () => undefined,
          )
          .exhaustive()
      }
      for (const edge of p.insertedRoleEdges) {
        requiredRoleEdges.push(edge)
      }
    }

    const mono = verifySubgraphMonomorphism(extractedOverlayGraph, expectedGraph, {
      requiredEntityKeys,
      requiredRelationIds,
      requiredRoleEdges,
    })

    // Also run Datalog inference over the extracted overlay graph to verify no new cycle/lattice errors
    const infExit = yield* Effect.exit(decideGraphInference(extractedOverlayGraph))
    const infDiag = match(infExit)
      .with({ _tag: "Failure" }, () => ["Datalog verification failed on projected overlay."])
      .with({ _tag: "Success" }, () => [])
      .exhaustive()

    const monoDiags: Array<string> = [
      ...mono.missingEntities.map((e) => `Missing projected entity in round-trip graph: ${e}`),
      ...mono.missingRelations.map((r) => `Missing projected relation in round-trip graph: ${r}`),
      ...mono.missingRoleEdges.map(
        (edge) =>
          `Missing projected role edge in round-trip graph: ${edge.relationId} --[${edge.role}]--> ${edge.entityKey}`,
      ),
    ]

    const allDiagnostics = [...errorDiags, ...monoDiags, ...infDiag]
    return {
      isClean: allDiagnostics.length === 0,
      diagnostics: allDiagnostics,
    }
  })

const safeProjectPatchesToInMemoryWorkspace = (
  repoRoot: string,
  targetGraph: HarnessGraph,
  patches: ReadonlyArray<GraphPatch>,
  initialGraph?: HarnessGraph,
  existingFiles?: Readonly<Record<string, string>>,
): Effect.Effect<
  ReturnType<typeof projectPatchesToInMemoryWorkspace>,
  GraphProjectorError,
  never
> =>
  Effect.try({
    try: () =>
      projectPatchesToInMemoryWorkspace(
        repoRoot,
        targetGraph,
        patches,
        initialGraph,
        existingFiles,
      ),
    catch: (err) =>
      new GraphProjectorError({
        reason: "ast-parse-error",
        message: String(err),
      }),
  })

/**
 * Binary-search fault isolation in $O(\log k)$ probes when a composite phase batch overlay fails (`RFC-0004 §4.5`).
 */
const isolateFirstOffendingPatchIndex = (
  repoRoot: string,
  baseGraph: HarnessGraph | undefined,
  targetGraph: HarnessGraph,
  prefixPatches: ReadonlyArray<GraphPatch>,
  phasePatches: ReadonlyArray<GraphPatch>,
  existingFiles?: Readonly<Record<string, string>>,
  forceFailRuleIds?: ReadonlySet<string>,
): Effect.Effect<
  { readonly offendingIndex: number; readonly probes: number },
  GraphProjectorError,
  never
> =>
  Effect.gen(function* () {
    let low = 0
    let high = phasePatches.length - 1
    let probes = 0

    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      probes += 1
      const candidateSlice = [...prefixPatches, ...phasePatches.slice(0, mid + 1)]
      const projected = yield* safeProjectPatchesToInMemoryWorkspace(
        repoRoot,
        targetGraph,
        candidateSlice,
        baseGraph,
        existingFiles,
      )
      const check = yield* verifyProjectedSubset(
        repoRoot,
        baseGraph,
        targetGraph,
        candidateSlice,
        projected.overlayMap,
        existingFiles,
        forceFailRuleIds,
      )
      if (!check.isClean) {
        high = mid
      } else {
        low = mid + 1
      }
    }

    return { offendingIndex: low, probes }
  })

/**
 * Pure Bidirectional AST Code Projector (`RFC-0004` §4.3–4.5, §5.1–5.2).
 *
 * Maps Double-Pushout `GraphPatch` deltas (`PLAN-01..04`, `REP-01..11`) into in-memory
 * TypeScript overlays (`ShadowFileOverlay`) via `ts-morph` (`{ useInMemoryFileSystem: true }`)
 * and `@ast-grep/napi`, co-projecting Nx package barrel files (`src/index.ts`) and verifying
 * the Stratum-Boundary Batch Shadow LSP Round-Trip Commutativity Law
 * $\alpha_{\Delta}(W_{\text{disk}} \oplus \Delta W_{\text{RAM}}^{(k)}) \cong H$ with $O(\log k)$
 * binary-search fault isolation.
 *
 * Enforces: harness:ADR-0009, harness:SPEC-0008
 */
export const decideGraphProjection = Effect.fn("GraphProjector.decide")(function* (
  input: GraphProjectorInput,
): Effect.fn.Return<AstProjectionResult, GraphProjectorError, never> {
  const repoRoot = resolveRepoRoot(
    input.workspaceRoot !== undefined ? String(input.workspaceRoot) : process.cwd(),
  )

  const allPatches: Array<GraphPatch> =
    input.patches.length > 0
      ? [...input.patches]
      : (input.appliedRewrites ?? []).flatMap((c) => c.patches)

  for (const patch of allPatches) {
    if (String(patch.ruleId).trim().length === 0) {
      return yield* new GraphProjectorError({
        reason: "Invalid GraphPatch with empty ruleId.",
      })
    }
    for (const ent of patch.insertedEntityNodes) {
      if ("file" in ent && String(ent.file).trim().length === 0) {
        return yield* new GraphProjectorError({
          ruleId: patch.ruleId,
          reason: "invalid-patch-target",
        })
      }
    }
  }

  if (allPatches.length === 0) {
    return {
      operations: [],
      overlays: [],
      roundTripVerified: true,
      compilerDiagnostics: [],
      bisectionProbes: BisectionProbeCount.make(0),
      skippedRuleIds: [],
    }
  }

  const shouldVerifyRoundTrip = input.verifyRoundTrip !== false
  const forceFailSet =
    input.forceFailRuleIds !== undefined
      ? new Set(input.forceFailRuleIds.map(String))
      : undefined

  if (!shouldVerifyRoundTrip) {
    const projected = yield* safeProjectPatchesToInMemoryWorkspace(
      repoRoot,
      input.targetGraph,
      allPatches,
      input.initialGraph,
      input.existingFiles,
    )
    return {
      operations: [...projected.operations],
      overlays: [...projected.overlays],
      roundTripVerified: true,
      compilerDiagnostics: [],
      bisectionProbes: BisectionProbeCount.make(0),
      skippedRuleIds: [],
    }
  }

  // Group patches by RewritePhase in canonical order (Stratum-Boundary Batch Verification, RFC-0004 §4.5)
  const phaseOrder: ReadonlyArray<RewritePhase> = [
    "PLAN",
    "REPAIR_ARCH",
    "REPAIR_CODE",
    "CLEANUP",
  ]
  const acceptedPatches: Array<GraphPatch> = []
  const skippedRuleIds: Array<RewriteRuleId> = []
  const collectedDiagnostics: Array<string> = []
  let totalBisectionProbes = 0

  for (const phase of phaseOrder) {
    let remainingInPhase = allPatches.filter((p) => p.phase === phase)
    if (remainingInPhase.length === 0) {
      continue
    }

    let phaseSettled = false
    while (!phaseSettled && remainingInPhase.length > 0) {
      const candidateBatch = [...acceptedPatches, ...remainingInPhase]
      const batchProjected = yield* safeProjectPatchesToInMemoryWorkspace(
        repoRoot,
        input.targetGraph,
        candidateBatch,
        input.initialGraph,
        input.existingFiles,
      )
      totalBisectionProbes += 1
      const batchCheck = yield* verifyProjectedSubset(
        repoRoot,
        input.initialGraph,
        input.targetGraph,
        candidateBatch,
        batchProjected.overlayMap,
        input.existingFiles,
        forceFailSet,
      )

      if (batchCheck.isClean) {
        acceptedPatches.push(...remainingInPhase)
        phaseSettled = true
      } else {
        collectedDiagnostics.push(...batchCheck.diagnostics)
        if (remainingInPhase.length === 1) {
          skippedRuleIds.push(remainingInPhase[0]!.ruleId)
          remainingInPhase = []
          phaseSettled = true
        } else {
          const bisected = yield* isolateFirstOffendingPatchIndex(
            repoRoot,
            input.initialGraph,
            input.targetGraph,
            acceptedPatches,
            remainingInPhase,
            input.existingFiles,
            forceFailSet,
          )
          totalBisectionProbes += bisected.probes
          const offending = remainingInPhase[bisected.offendingIndex]
          if (offending !== undefined) {
            skippedRuleIds.push(offending.ruleId)
          }
          acceptedPatches.push(...remainingInPhase.slice(0, bisected.offendingIndex))
          remainingInPhase = remainingInPhase.slice(bisected.offendingIndex + 1)
        }
      }
    }
  }

  const finalProjected = yield* safeProjectPatchesToInMemoryWorkspace(
    repoRoot,
    input.targetGraph,
    acceptedPatches,
    input.initialGraph,
    input.existingFiles,
  )

  return {
    operations: [...finalProjected.operations],
    overlays: [...finalProjected.overlays],
    roundTripVerified: skippedRuleIds.length === 0,
    compilerDiagnostics: Array.from(new Set(collectedDiagnostics)),
    bisectionProbes: BisectionProbeCount.make(totalBisectionProbes),
    skippedRuleIds,
  }
})

export const GraphProjector = {
  decide: decideGraphProjection,
} as const
