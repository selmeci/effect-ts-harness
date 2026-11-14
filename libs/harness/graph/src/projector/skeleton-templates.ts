import * as path from "node:path"
import { Lang, parse } from "@ast-grep/napi"
import type { SyncHostIo } from "@harness/service"
import { Schema } from "effect"
import { Node, type Project, type SourceFile, SyntaxKind, VariableDeclarationKind } from "ts-morph"
import { match } from "ts-pattern"
import {
  type EffectFnNode,
  type EntityNode,
  type HarnessGraph,
  type MigrationTupleRelation,
  NodeKey,
  type PlaysRoleEdge,
  RelationId,
  type RelationNode,
  RewriteCandidate,
  RewriteRuleId,
  type SchemaDefNode,
  type ServiceLayerNode,
  type ServiceTagNode,
  type TaggedErrorNode,
  type VitestCaseNode,
  getNodeKey,
} from "../model.js"
import { resolveContainedRelPath } from "../extractor/extractor-types-and-helpers.js"

export const TargetFilePath = Schema.NonEmptyString.pipe(Schema.brand("TargetFilePath"))
export type TargetFilePath = typeof TargetFilePath.Type
export const TypeScriptSnippet = Schema.String.pipe(Schema.brand("TypeScriptSnippet"))
export type TypeScriptSnippet = typeof TypeScriptSnippet.Type
export const SpecificationRef = Schema.NonEmptyString.pipe(Schema.brand("SpecificationRef"))
export type SpecificationRef = typeof SpecificationRef.Type
export const CodeModEngineKind = Schema.Literals(["ts-morph", "ast-grep"])
export type CodeModEngineKind = typeof CodeModEngineKind.Type
export const CodeModActionKind = Schema.Literals(["insert-declaration", "update-signature", "replace-expression", "remove-declaration", "ensure-import"])
export type CodeModActionKind = typeof CodeModActionKind.Type
export const VerificationStatus = Schema.Literals(["Verified", "Partial", "Unverified"])
export type VerificationStatus = typeof VerificationStatus.Type
export const BisectionProbeCount = Schema.Natural.pipe(Schema.brand("BisectionProbeCount"))
export type BisectionProbeCount = typeof BisectionProbeCount.Type

export const AstCodeModOperation = Schema.Struct({
  ruleId: RewriteRuleId, engine: CodeModEngineKind, action: CodeModActionKind, targetFile: TargetFilePath,
  targetSymbol: Schema.optionalKey(NodeKey), targetRelation: Schema.optionalKey(RelationId), snippet: TypeScriptSnippet, rationale: SpecificationRef,
})
export type AstCodeModOperation = typeof AstCodeModOperation.Type
export const ShadowFileOverlay = Schema.Struct({ targetFile: TargetFilePath, content: TypeScriptSnippet })
export type ShadowFileOverlay = typeof ShadowFileOverlay.Type
export const ProjectedArtifact = ShadowFileOverlay
export type ProjectedArtifact = ShadowFileOverlay

export const AstProjectionResult = Schema.Struct({
  operations: Schema.Array(AstCodeModOperation), overlays: Schema.Array(ShadowFileOverlay), verificationStatus: VerificationStatus,
  roundTripVerified: Schema.Boolean, compilerDiagnostics: Schema.Array(Schema.String), bisectionProbes: BisectionProbeCount, skippedRuleIds: Schema.Array(RewriteRuleId),
})
export type AstProjectionResult = typeof AstProjectionResult.Type

export interface GraphProjectorInput {
  readonly initialGraph?: HarnessGraph | undefined
  readonly targetGraph: HarnessGraph
  readonly patches: ReadonlyArray<import("../model.js").GraphPatch>
  readonly appliedRewrites?: ReadonlyArray<RewriteCandidate> | undefined
  readonly workspaceRoot?: TargetFilePath | string | undefined
  readonly existingFiles?: Readonly<Record<string, string>> | undefined
  readonly verifyRoundTrip?: boolean | undefined
  readonly forceFailRuleIds?: ReadonlyArray<RewriteRuleId | string> | undefined
  readonly hostIo?: SyncHostIo | undefined
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

export const sanitizeIdentifier = (raw: string): string => {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "")
  if (cleaned.length === 0) return "Synthesized"
  return /^[0-9]/.test(cleaned) ? `S_${cleaned}` : cleaned
}

export const validateRelPath = (
  repoRoot: string, rawPath: string, ruleId?: RewriteRuleId, hostIo?: SyncHostIo,
): { readonly ok: true; readonly relPath: string } | { readonly ok: false; readonly error: GraphProjectorError } => {
  const trimmed = (rawPath ?? "").trim()
  if (trimmed.length === 0) {
    return { ok: false, error: new GraphProjectorError({ ...(ruleId !== undefined ? { ruleId } : {}), reason: "invalid-patch-target", message: "Target file path cannot be empty." }) }
  }
  const rel = resolveContainedRelPath(repoRoot, trimmed, hostIo)
  if (rel === null) {
    return { ok: false, error: new GraphProjectorError({ ...(ruleId !== undefined ? { ruleId } : {}), reason: "invalid-patch-target", message: `Target file path '${rawPath}' escapes workspace root '${repoRoot}'.` }) }
  }
  return { ok: true, relPath: rel }
}

export const normalizeRelPath = (repoRoot: string, rawPath: string, ruleId?: RewriteRuleId): string => {
  const res = validateRelPath(repoRoot, rawPath, ruleId)
  return res.ok ? res.relPath : "__invalid_target__"
}

export const computeRelativeModuleSpec = (fromFile: string, toFile: string): string => {
  const fromDir = path.posix.dirname(fromFile)
  let rel = path.posix.relative(fromDir, toFile)
  if (!rel.startsWith(".")) rel = `./${rel}`
  return rel.replace(/\.tsx?$/, ".js")
}

export interface ProjectorContext {
  readonly repoRoot: string
  readonly project: Project
  readonly initialContents: Map<string, string>
  readonly modifiedFiles: Set<string>
  readonly exportedSymbolsByFile: Map<string, Set<string>>
  readonly operations: Array<AstCodeModOperation>
  readonly targetEntitiesByKey: Map<string, EntityNode>
  readonly targetRelationsById: Map<string, RelationNode>
  readonly targetEdgesByRelId: Map<string, Array<PlaysRoleEdge>>
  pendingError?: GraphProjectorError | undefined
}

export const readInitialFileContent = (
  repoRoot: string,
  relPath: string,
  existingFiles?: Readonly<Record<string, string>>,
  hostIo?: SyncHostIo,
): string | undefined => {
  if (existingFiles !== undefined) {
    if (existingFiles[relPath] !== undefined) return existingFiles[relPath]
    const absKey = path.resolve(repoRoot, relPath).replace(/\\/g, "/")
    if (existingFiles[absKey] !== undefined) return existingFiles[absKey]
  }
  if (hostIo === undefined) return undefined
  const fullPath = path.resolve(repoRoot, relPath)
  return hostIo.existsSync(fullPath) ? hostIo.readTextSync(fullPath) : undefined
}

export const getOrCreateSourceFile = (
  ctx: ProjectorContext, relFile: string,
  options?: { readonly requireExisting?: boolean | undefined; readonly ruleId?: RewriteRuleId | undefined },
): { readonly sf: SourceFile; readonly norm: string } => {
  const validated = validateRelPath(ctx.repoRoot, relFile, options?.ruleId)
  if (!validated.ok) {
    ctx.pendingError ??= validated.error
    const fallbackSf = ctx.project.getSourceFile("/__invalid_target__.ts") ?? ctx.project.createSourceFile("/__invalid_target__.ts", "", { overwrite: true })
    return { sf: fallbackSf, norm: "__invalid_target__.ts" }
  }
  const norm = validated.relPath, memPath = `/${norm}`
  let sf = ctx.project.getSourceFile(memPath)
  if (sf === undefined) {
    const initial = ctx.initialContents.get(norm)
    if (initial === undefined && options?.requireExisting === true) {
      ctx.pendingError ??= new GraphProjectorError({
        ...(options.ruleId !== undefined ? { ruleId: options.ruleId } : {}),
        targetFile: TargetFilePath.make(norm), reason: "missing-target-file",
        message: `Repair target file '${norm}' does not exist on disk or in existingFiles.`,
      })
    }
    sf = ctx.project.createSourceFile(memPath, initial ?? "", { overwrite: true })
  }
  return { sf, norm }
}

export const recordExportedSymbol = (ctx: ProjectorContext, relFile: string, symbolName: string): void => {
  let set = ctx.exportedSymbolsByFile.get(relFile)
  if (set === undefined) {
    set = new Set<string>()
    ctx.exportedSymbolsByFile.set(relFile, set)
  }
  set.add(symbolName)
}

export const ensureNamedImport = (
  ctx: ProjectorContext, relFile: string, moduleSpec: string, namedImports: ReadonlyArray<string>, ruleId: RewriteRuleId, rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, relFile)
  const existingDecl = sf.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === moduleSpec)
  const addedNames: Array<string> = []
  if (existingDecl !== undefined) {
    const currentNames = new Set(existingDecl.getNamedImports().map((n) => n.getName()))
    for (const name of namedImports) {
      if (!currentNames.has(name)) {
        existingDecl.addNamedImport(name)
        addedNames.push(name)
      }
    }
  } else {
    if (namedImports.length > 0) {
      sf.insertImportDeclaration(0, { moduleSpecifier: moduleSpec, namedImports: [...namedImports] })
      addedNames.push(...namedImports)
    }
  }
  if (addedNames.length > 0) {
    ctx.modifiedFiles.add(norm)
    ctx.operations.push({
      ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("ensure-import"),
      targetFile: TargetFilePath.make(norm), snippet: TypeScriptSnippet.make(`import { ${addedNames.join(", ")} } from "${moduleSpec}"`),
      rationale: SpecificationRef.make(rationale),
    })
  }
}

export const resolveFileForEntityKey = (ctx: ProjectorContext, entityKey: string): string | undefined => {
  const ent = ctx.targetEntitiesByKey.get(entityKey)
  if (ent === undefined) return undefined
  return match(ent)
    .with({ _tag: "EffectFn" }, (n) => n.file).with({ _tag: "ServiceTag" }, (n) => n.file)
    .with({ _tag: "ServiceLayer" }, (n) => n.file).with({ _tag: "TaggedError" }, (n) => n.file)
    .with({ _tag: "SchemaDef" }, (n) => n.file).with({ _tag: "VitestCase" }, (n) => n.testFile)
    .with({ _tag: "PatternDoc" }, (n) => n.path).with({ _tag: "AdrDoc" }, (n) => n.path)
    .with({ _tag: "EarsSpec" }, (n) => n.path).exhaustive()
}

export const resolveExportNameForEntityKey = (ctx: ProjectorContext, entityKey: string): string | undefined => {
  const ent = ctx.targetEntitiesByKey.get(entityKey)
  if (ent !== undefined) {
    return match(ent)
      .with({ _tag: "EffectFn" }, (n) => sanitizeIdentifier(n.qualname.split("#").pop() ?? n.spanName))
      .with({ _tag: "ServiceTag" }, (n) => sanitizeIdentifier(n.name))
      .with({ _tag: "ServiceLayer" }, (n) => sanitizeIdentifier(n.qualname.split("#").pop() ?? "SynthesizedLive"))
      .with({ _tag: "TaggedError" }, (n) => sanitizeIdentifier(n.errorTag))
      .with({ _tag: "SchemaDef" }, (n) => sanitizeIdentifier(n.schemaName))
      .with({ _tag: "VitestCase" }, { _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, () => undefined)
      .exhaustive()
  }
  const rawTail = entityKey.split(":").slice(1).join(":").split("#").pop()
  return rawTail !== undefined && rawTail.length > 0 ? sanitizeIdentifier(rawTail) : undefined
}

export const projectSchemaDefNode = (
  ctx: ProjectorContext, node: SchemaDefNode, ruleId: RewriteRuleId, rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file, { requireExisting: String(ruleId) === "REP-06", ruleId })
  const schemaIdent = sanitizeIdentifier(node.schemaName)
  ensureNamedImport(ctx, norm, "effect", ["Schema"], ruleId, rationale)

  const existingVar = sf.getVariableDeclaration(schemaIdent)
  if (existingVar !== undefined) {
    const init = existingVar.getInitializer()
    const initText = init?.getText() ?? ""
    if (node.isBranded === true && !initText.includes("Schema.brand") && !initText.includes(".brand(")) {
      const nextInit = `${initText || "Schema.NonEmptyString"}.pipe(Schema.brand("${schemaIdent}"))`
      existingVar.setInitializer(nextInit)
      if (sf.getTypeAlias(schemaIdent) === undefined) {
        sf.addTypeAlias({ isExported: true, name: schemaIdent, type: `typeof ${schemaIdent}.Type` })
      }
      ctx.modifiedFiles.add(norm)
      recordExportedSymbol(ctx, norm, schemaIdent)
      ctx.operations.push({
        ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("replace-expression"),
        targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(getNodeKey(node)),
        snippet: TypeScriptSnippet.make(`export const ${schemaIdent} = ${nextInit}\nexport type ${schemaIdent} = typeof ${schemaIdent}.Type`),
        rationale: SpecificationRef.make(rationale),
      })
    }
    return
  }

  const fieldIdIdent = `${schemaIdent}Id`
  const snippetLines: Array<string> = []
  if (sf.getVariableDeclaration(fieldIdIdent) === undefined && schemaIdent.endsWith("Input")) {
    sf.addVariableStatement({
      isExported: true, declarationKind: VariableDeclarationKind.Const,
      declarations: [{ name: fieldIdIdent, initializer: `Schema.NonEmptyString.pipe(Schema.brand("${fieldIdIdent}"))` }],
    })
    sf.addTypeAlias({ isExported: true, name: fieldIdIdent, type: `typeof ${fieldIdIdent}.Type` })
    recordExportedSymbol(ctx, norm, fieldIdIdent)
    snippetLines.push(`export const ${fieldIdIdent} = Schema.NonEmptyString.pipe(Schema.brand("${fieldIdIdent}"))`, `export type ${fieldIdIdent} = typeof ${fieldIdIdent}.Type`)
  }

  const initializer = schemaIdent.endsWith("Input")
    ? `Schema.Struct({ id: ${fieldIdIdent} }).pipe(Schema.brand("${schemaIdent}"))`
    : `Schema.NonEmptyString.pipe(Schema.brand("${schemaIdent}"))`

  sf.addVariableStatement({
    isExported: true, declarationKind: VariableDeclarationKind.Const,
    declarations: [{ name: schemaIdent, initializer }],
  })
  if (sf.getTypeAlias(schemaIdent) === undefined) {
    sf.addTypeAlias({ isExported: true, name: schemaIdent, type: `typeof ${schemaIdent}.Type` })
  }

  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, schemaIdent)
  snippetLines.push(`export const ${schemaIdent} = ${initializer}`, `export type ${schemaIdent} = typeof ${schemaIdent}.Type`)
  ctx.operations.push({
    ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(snippetLines.join("\n")), rationale: SpecificationRef.make(rationale),
  })
}

export const projectTaggedErrorNode = (
  ctx: ProjectorContext, node: TaggedErrorNode, ruleId: RewriteRuleId, rationale: string,
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
      isExported: true, declarationKind: VariableDeclarationKind.Const,
      declarations: [{ name: reasonIdent, initializer: `Schema.NonEmptyString.pipe(Schema.brand("${reasonIdent}"))` }],
    })
    sf.addTypeAlias({ isExported: true, name: reasonIdent, type: `typeof ${reasonIdent}.Type` })
    recordExportedSymbol(ctx, norm, reasonIdent)
  }

  const clsSnippet = `export class ${errIdent} extends Schema.TaggedError<${errIdent}>()("${node.errorTag}", {\n  reason: ${reasonIdent},\n}) {}`
  sf.addStatements(clsSnippet)
  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, errIdent)
  ctx.operations.push({
    ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(clsSnippet), rationale: SpecificationRef.make(rationale),
  })
}

export const projectServiceTagNode = (
  ctx: ProjectorContext, node: ServiceTagNode, ruleId: RewriteRuleId, rationale: string,
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
    ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(clsSnippet), rationale: SpecificationRef.make(rationale),
  })
}

export const collectSignatureTypesForFn = (
  ctx: ProjectorContext, fnNode: EffectFnNode,
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
  const errorTypes: Array<string> = [], serviceTypes: Array<string> = []
  const errorEntityKeys: Array<string> = [], serviceEntityKeys: Array<string> = [], schemaEntityKeys: Array<string> = []
  let inputSchemaFromEdge: string | undefined, outputSchemaFromEdge: string | undefined

  for (const [, edges] of ctx.targetEdgesByRelId.entries()) {
    if (!edges.some((e) => e.entityKey === fnKey && match<string>(e.role).with("caller", () => true).otherwise(() => false))) continue
    for (const e of edges) {
      const name = resolveExportNameForEntityKey(ctx, e.entityKey)
      if (name === undefined) continue
      match<string>(e.role)
        .with("fails-with", () => { if (!errorTypes.includes(name)) { errorTypes.push(name); errorEntityKeys.push(e.entityKey) } })
        .with("requires-service", () => { if (!serviceTypes.includes(name)) { serviceTypes.push(name); serviceEntityKeys.push(e.entityKey) } })
        .with("input-schema", () => { inputSchemaFromEdge = name; schemaEntityKeys.push(e.entityKey) })
        .with("output-schema", () => { outputSchemaFromEdge = name; schemaEntityKeys.push(e.entityKey) })
        .otherwise(() => {})
    }
  }

  const inputType = fnNode.inputSchema !== undefined ? sanitizeIdentifier(fnNode.inputSchema) : (inputSchemaFromEdge ?? "unknown")
  const successType = fnNode.outputSchema !== undefined
    ? sanitizeIdentifier(fnNode.outputSchema)
    : fnNode.successType !== undefined && fnNode.successType !== "unknown"
      ? sanitizeIdentifier(fnNode.successType)
      : (outputSchemaFromEdge ?? (inputType !== "unknown" ? inputType : "void"))

  return { inputType, successType, errorTypes: errorTypes.sort(), serviceTypes: serviceTypes.sort(), errorEntityKeys, serviceEntityKeys, schemaEntityKeys }
}

export const ensureCrossFileImportsForEntityKeys = (
  ctx: ProjectorContext, fromRelFile: string, entityKeys: ReadonlyArray<string>, ruleId: RewriteRuleId, rationale: string,
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

export const projectEffectFnNode = (
  ctx: ProjectorContext, node: EffectFnNode, ruleId: RewriteRuleId, rationale: string,
  options?: { readonly requireExisting?: boolean | undefined },
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file, { requireExisting: options?.requireExisting, ruleId })
  const fnIdent = sanitizeIdentifier(node.qualname.split("#").pop() ?? node.spanName)
  ensureNamedImport(ctx, norm, "effect", ["Effect", "Schema"], ruleId, rationale)

  const sigInfo = collectSignatureTypesForFn(ctx, node)
  ensureCrossFileImportsForEntityKeys(ctx, norm, [...sigInfo.errorEntityKeys, ...sigInfo.serviceEntityKeys, ...sigInfo.schemaEntityKeys], ruleId, rationale)

  const existingVar = sf.getVariableDeclaration(fnIdent)
  let effectiveInputType = sigInfo.inputType
  if (effectiveInputType === "unknown" && existingVar === undefined) {
    const fallbackInputIdent = `${fnIdent}Input`
    if (sf.getVariableDeclaration(fallbackInputIdent) === undefined && sf.getTypeAlias(fallbackInputIdent) === undefined) {
      sf.addVariableStatement({
        isExported: true, declarationKind: VariableDeclarationKind.Const,
        declarations: [{ name: fallbackInputIdent, initializer: `Schema.NonEmptyString.pipe(Schema.brand("${fallbackInputIdent}"))` }],
      })
      sf.addTypeAlias({ isExported: true, name: fallbackInputIdent, type: `typeof ${fallbackInputIdent}.Type` })
      recordExportedSymbol(ctx, norm, fallbackInputIdent)
    }
    effectiveInputType = fallbackInputIdent
  }

  const effectiveSuccessType = sigInfo.successType === "void" || sigInfo.successType === "unknown" ? effectiveInputType : sigInfo.successType
  const eChannel = sigInfo.errorTypes.length > 0 ? sigInfo.errorTypes.join(" | ") : "never"
  const rChannel = sigInfo.serviceTypes.length > 0 ? sigInfo.serviceTypes.join(" | ") : "never"

  if (node.isStub === true && sf.getVariableDeclaration("stub") === undefined) {
    const hasStubImport = sf.getImportDeclarations().some((d) => d.getNamedImports().some((n) => n.getName() === "stub"))
    if (!hasStubImport) ensureNamedImport(ctx, norm, "@harness/contract", ["stub"], ruleId, rationale)
  }

  const catchSuffix =
    node.caughtErrors !== undefined && node.caughtErrors.length > 0
      ? node.caughtErrors.map((tag) => `.pipe(Effect.catchTag("${tag}", () => Effect.succeed(input)))`).join("")
      : ""

  if (existingVar !== undefined) {
    const stubCall = existingVar.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => c.getExpression().getText() === "stub")
    const innerFn =
      existingVar.getDescendantsOfKind(SyntaxKind.FunctionExpression)[0] ??
      existingVar.getDescendantsOfKind(SyntaxKind.ArrowFunction)[0]

    let preservedSuccess = effectiveSuccessType
    if (innerFn !== undefined) {
      const existingRetNode = innerFn.getReturnTypeNode()
      if ((preservedSuccess === "unknown" || preservedSuccess === "void") && existingRetNode !== undefined && Node.isTypeReference(existingRetNode)) {
        const firstTypeArg = existingRetNode.getTypeArguments()[0]?.getText()
        if (firstTypeArg !== undefined && firstTypeArg.length > 0) preservedSuccess = firstTypeArg
      }
      if (preservedSuccess === "unknown" && innerFn.getParameters()[0]?.getTypeNode() !== undefined) {
        preservedSuccess = innerFn.getParameters()[0]!.getTypeNode()!.getText()
      }
    }
    if (preservedSuccess === "unknown") preservedSuccess = "void"

    if (stubCall !== undefined) {
      for (const ta of [...stubCall.getTypeArguments()].reverse()) stubCall.removeTypeArgument(ta)
      stubCall.addTypeArguments([preservedSuccess, eChannel, rChannel])
    }

    if (innerFn !== undefined) {
      const firstParam = innerFn.getParameters()[0]
      const paramName = firstParam?.getName() ?? "input"
      if (firstParam !== undefined && firstParam.getTypeNode() === undefined && effectiveInputType !== "unknown") {
        firstParam.setType(effectiveInputType)
      }
      innerFn.setReturnType(`Effect.fn.Return<${preservedSuccess}, ${eChannel}, ${rChannel}>`)

      if (Node.isFunctionExpression(innerFn) && innerFn.isGenerator()) {
        const body = innerFn.getBody()
        if (Node.isBlock(body)) {
          if (stubCall === undefined && sigInfo.serviceTypes.length > 0) {
            const bodyText = body.getText()
            const missingSvcStmts = sigInfo.serviceTypes.filter((svcName) => !bodyText.includes(svcName)).map((svcName) => `yield* ${svcName}`)
            if (missingSvcStmts.length > 0) body.insertStatements(0, missingSvcStmts.join("\n"))
          }

          if (node.caughtErrors !== undefined && node.caughtErrors.length > 0) {
            const paramAwareCatch = node.caughtErrors.map((tag) => `.pipe(Effect.catchTag("${tag}", () => Effect.succeed(${paramName})))`).join("")
            const yieldExprs = body.getDescendantsOfKind(SyntaxKind.YieldExpression)
            const targetYield = yieldExprs[yieldExprs.length - 1]
            if (targetYield !== undefined) {
              const yielded = targetYield.getExpression()
              if (yielded !== undefined && !yielded.getText().includes("Effect.catchTag")) {
                yielded.replaceWithText(`(${yielded.getText()})${paramAwareCatch}`)
              }
            } else {
              const retStmts = body.getStatements().filter(Node.isReturnStatement)
              const lastRet = retStmts[retStmts.length - 1]
              const retExpr = lastRet?.getExpression()
              if (retExpr !== undefined && !retExpr.getText().includes("Effect.catchTag")) {
                retExpr.replaceWithText(`yield* Effect.succeed(${retExpr.getText()})${paramAwareCatch}`)
              }
            }
          }
        }
      }
    }

    const updatedSnippet = existingVar.getVariableStatement()?.getText() ?? `export const ${fnIdent} = ${existingVar.getInitializer()?.getText() ?? ""}`
    ctx.modifiedFiles.add(norm)
    recordExportedSymbol(ctx, norm, fnIdent)
    ctx.operations.push({
      ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("update-signature"),
      targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(getNodeKey(node)),
      snippet: TypeScriptSnippet.make(updatedSnippet), rationale: SpecificationRef.make(rationale),
    })
    return
  }

  const bodyStatement = catchSuffix.length > 0
    ? (node.isStub === true
        ? `return yield* stub<${effectiveSuccessType}, ${eChannel}, ${rChannel}>(input)${catchSuffix}`
        : `return yield* Effect.succeed(input)${catchSuffix}`)
    : (node.isStub === true
        ? `return yield* stub<${effectiveSuccessType}, ${eChannel}, ${rChannel}>(input)`
        : `return input`)

  const fnInitializer = `Effect.fn("${node.spanName}")(function* (\n  input: ${effectiveInputType},\n): Effect.fn.Return<${effectiveSuccessType}, ${eChannel}, ${rChannel}> {\n  ${bodyStatement}\n})`
  const fullSnippet = `export const ${fnIdent} = ${fnInitializer}`

  sf.addStatements(fullSnippet)
  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, fnIdent)
  ctx.operations.push({
    ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(getNodeKey(node)),
    snippet: TypeScriptSnippet.make(fullSnippet), rationale: SpecificationRef.make(rationale),
  })
}

export const projectServiceLayerNode = (
  ctx: ProjectorContext, node: ServiceLayerNode, ruleId: RewriteRuleId, rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.file)
  const layerIdent = sanitizeIdentifier((node.qualname ?? "").split("#").pop() ?? "SynthesizedLive")
  ensureNamedImport(ctx, norm, "effect", ["Effect", "Layer"], ruleId, rationale)

  const layerKey = getNodeKey(node)
  const providedServiceKeys: Array<string> = [], requiredServiceKeys: Array<string> = []

  for (const [, edges] of ctx.targetEdgesByRelId.entries()) {
    if (!edges.some((e) => e.entityKey === layerKey && match<string>(e.role).with("provider-layer", () => true).otherwise(() => false))) continue
    for (const e of edges) {
      match<string>(e.role)
        .with("provided-service", () => { providedServiceKeys.push(e.entityKey) })
        .with("required-service", () => { requiredServiceKeys.push(e.entityKey) })
        .otherwise(() => {})
    }
  }

  ensureCrossFileImportsForEntityKeys(ctx, norm, [...providedServiceKeys, ...requiredServiceKeys], ruleId, rationale)

  const providedNames = providedServiceKeys.map((k) => resolveExportNameForEntityKey(ctx, k)).filter((n): n is string => n !== undefined)
  const requiredNames = requiredServiceKeys.map((k) => resolveExportNameForEntityKey(ctx, k)).filter((n): n is string => n !== undefined)
  const primaryProvided = providedNames[0] ?? "never"
  const rOut = providedNames.length > 0 ? providedNames.join(" | ") : "never"
  const rIn = requiredNames.length > 0 ? requiredNames.join(" | ") : "never"
  const existingVar = sf.getVariableDeclaration(layerIdent)
  const yieldRequiredLines = requiredNames.map((req) => `    yield* ${req}`).join("\n")

  if (existingVar !== undefined) {
    existingVar.setType(`Layer.Layer<${rOut}, never, ${rIn}>`)
    const init = existingVar.getInitializer()
    if (init !== undefined && requiredNames.length > 0) {
      const genFn = init.getDescendantsOfKind(SyntaxKind.FunctionExpression).find((f) => f.isGenerator())
      if (genFn !== undefined) {
        const body = genFn.getBody()
        if (Node.isBlock(body)) {
          const bodyText = body.getText()
          const missingYields = requiredNames.filter((req) => !bodyText.includes(req)).map((req) => `yield* ${req}`)
          if (missingYields.length > 0) body.insertStatements(0, missingYields.join("\n"))
        }
      } else {
        if (Node.isCallExpression(init) && init.getArguments().length >= 2) {
          const calleeText = init.getExpression().getText()
          const tagArg = init.getArguments()[0]!.getText()
          const implArg = init.getArguments()[1]!.getText()
          const missingYields = requiredNames.filter((req) => !implArg.includes(req)).map((req) => `    yield* ${req}`).join("\n")
          if (missingYields.length > 0 && (calleeText === "Layer.succeed" || calleeText === "Layer.sync" || calleeText === "Layer.effect")) {
            const returnExpr = calleeText === "Layer.sync" ? `(${implArg})()` : calleeText === "Layer.effect" ? `yield* (${implArg})` : implArg
            existingVar.setInitializer(`Layer.effect(\n  ${tagArg},\n  Effect.gen(function* () {\n${missingYields}\n    return ${returnExpr}\n  }),\n)`)
          }
        }
      }
    }

    const updatedDeclSnippet = existingVar.getVariableStatement()?.getText() ?? `export const ${layerIdent}: Layer.Layer<${rOut}, never, ${rIn}> = ${existingVar.getInitializer()?.getText() ?? ""}`
    ctx.modifiedFiles.add(norm)
    recordExportedSymbol(ctx, norm, layerIdent)
    ctx.operations.push({
      ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("update-signature"),
      targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(layerKey),
      snippet: TypeScriptSnippet.make(updatedDeclSnippet), rationale: SpecificationRef.make(rationale),
    })
    return
  }

  const layerInit = primaryProvided !== "never"
    ? requiredNames.length > 0
      ? `Layer.effect(\n  ${primaryProvided},\n  Effect.gen(function* () {\n${yieldRequiredLines}\n    return ${primaryProvided}.of({\n      execute: () => Effect.void,\n    })\n  }),\n)`
      : `Layer.effect(\n  ${primaryProvided},\n  Effect.sync(() => ${primaryProvided}.of({\n    execute: () => Effect.void,\n  })),\n)`
    : `Layer.empty`

  const declSnippet = `export const ${layerIdent}: Layer.Layer<${rOut}, never, ${rIn}> = ${layerInit}`
  sf.addStatements(declSnippet)
  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, layerIdent)
  ctx.operations.push({
    ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(layerKey),
    snippet: TypeScriptSnippet.make(declSnippet), rationale: SpecificationRef.make(rationale),
  })
}

export const projectVitestCaseNode = (
  ctx: ProjectorContext, node: VitestCaseNode, ruleId: RewriteRuleId, rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, node.testFile)
  if (sf.getFullText().includes(node.testName)) return

  ensureNamedImport(ctx, norm, "@effect/vitest", ["describe", "expect", "it"], ruleId, rationale)
  ensureNamedImport(ctx, norm, "effect", ["Effect", "Schema"], ruleId, rationale)

  const testKey = getNodeKey(node)
  const exercisedFnKeys: Array<string> = []
  for (const [, edges] of ctx.targetEdgesByRelId.entries()) {
    if (!edges.some((e) => e.entityKey === testKey && match<string>(e.role).with("verifying-test", "exercising-test", () => true).otherwise(() => false))) continue
    for (const e of edges) {
      if (e.entityKey.startsWith("EffectFn:")) {
        match<string>(e.role).with("realizing-symbol", "exercised-span", () => { exercisedFnKeys.push(e.entityKey) }).otherwise(() => {})
      }
    }
  }

  ensureCrossFileImportsForEntityKeys(ctx, norm, exercisedFnKeys, ruleId, rationale)
  const exercisedFnNames = exercisedFnKeys.map((k) => resolveExportNameForEntityKey(ctx, k)).filter((n): n is string => n !== undefined)
  const callComment = exercisedFnNames.length > 0 ? `      void ${exercisedFnNames[0]}\n` : ""
  const testSnippet = `describe("${node.testName}", () => {\n  it.effect.prop(\n    "${node.testName}",\n    { value: Schema.NonEmptyString },\n    ({ value }: { readonly value: string }) =>\n      Effect.gen(function* () {\n${callComment}        expect(value.length).toBeGreaterThan(0)\n      }),\n  )\n})`

  sf.addStatements(testSnippet)
  ctx.modifiedFiles.add(norm)
  ctx.operations.push({
    ruleId, engine: CodeModEngineKind.make("ts-morph"), action: CodeModActionKind.make("insert-declaration"),
    targetFile: TargetFilePath.make(norm), targetSymbol: NodeKey.make(testKey),
    snippet: TypeScriptSnippet.make(testSnippet), rationale: SpecificationRef.make(rationale),
  })
}

export const projectMigrationTupleRelation = (
  ctx: ProjectorContext, rel: MigrationTupleRelation, ruleId: RewriteRuleId, rationale: string,
): void => {
  const { sf, norm } = getOrCreateSourceFile(ctx, rel.moduleFile, { requireExisting: true, ruleId })
  if (sf.getFullText().includes("SqliteMigrator.fromRecord") && sf.getFullText().includes(rel.migrationId)) return

  ensureNamedImport(ctx, norm, "effect", ["Effect"], ruleId, rationale)
  ensureNamedImport(ctx, norm, "@effect/sql-sqlite-do", ["SqliteClient", "SqliteMigrator"], ruleId, rationale)

  const rootNode = parse(Lang.TypeScript, sf.getFullText()).root()
  const rawSqlMatches = rootNode.findAll("sql`$DDL`").filter((m) => /\b(?:CREATE|ALTER)\s+TABLE\b/i.test(m.text()))
  const ddlBody = rawSqlMatches.length > 0 ? rawSqlMatches[0]!.text() : "sql`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY)`"
  const migrationSnippet = `export const migrations = SqliteMigrator.fromRecord({\n  "${rel.migrationId}": Effect.gen(function* () {\n    const sql = yield* SqliteClient.SqliteClient\n    yield* ${ddlBody}\n  }),\n})`

  if (rawSqlMatches.length > 0) {
    const updatedText = sf.getFullText().replace(rawSqlMatches[0]!.text(), "Effect.void")
    sf.replaceWithText(`${updatedText.trimEnd()}\n\n${migrationSnippet}\n`)
  } else {
    sf.addStatements(migrationSnippet)
  }

  ctx.modifiedFiles.add(norm)
  recordExportedSymbol(ctx, norm, "migrations")
  ctx.operations.push({
    ruleId, engine: CodeModEngineKind.make("ast-grep"), action: CodeModActionKind.make("replace-expression"),
    targetFile: TargetFilePath.make(norm), targetRelation: rel.relationId,
    snippet: TypeScriptSnippet.make(migrationSnippet), rationale: SpecificationRef.make(rationale),
  })
}
