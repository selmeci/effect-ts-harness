import { Lang, parse } from "@ast-grep/napi"
import type { SyncHostIo } from "@harness/service"
import * as Graph from "effect/Graph"
import { Node, Project, SyntaxKind, ts } from "ts-morph"
import { match } from "ts-pattern"
import {
  type EntityNode,
  type GraphPatch,
  type HarnessGraph,
  NodeKey,
  type PlaysRoleEdge,
  type RelationNode,
  type RewriteRuleId,
  getNodeKey,
} from "../model.js"
import {
  type AstCodeModOperation,
  CodeModActionKind,
  CodeModEngineKind,
  GraphProjectorError,
  type ProjectorContext,
  type ShadowFileOverlay,
  SpecificationRef,
  TargetFilePath,
  TypeScriptSnippet,
  ensureNamedImport,
  getOrCreateSourceFile,
  normalizeRelPath,
  projectEffectFnNode,
  projectMigrationTupleRelation,
  projectSchemaDefNode,
  projectServiceLayerNode,
  projectServiceTagNode,
  projectTaggedErrorNode,
  projectVitestCaseNode,
  readInitialFileContent,
  recordExportedSymbol,
  sanitizeIdentifier,
  validateRelPath,
} from "./skeleton-templates.js"

export const applyRep05UntracedDeciderRepair = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  rationale: string,
): void => {
  for (const insEnt of patch.insertedEntityNodes) {
    match(insEnt)
      .with({ _tag: "EffectFn" }, (fnEnt) => {
        const { sf, norm } = getOrCreateSourceFile(ctx, fnEnt.file, {
          requireExisting: true,
          ruleId: patch.ruleId,
        })
        const fnIdent = sanitizeIdentifier(fnEnt.qualname.split("#").pop() ?? fnEnt.spanName)
        const varDecl = sf.getVariableDeclaration(fnIdent)
        if (varDecl !== undefined) {
          const init = varDecl.getInitializer()
          if (init !== undefined) {
            const initText = init.getText()
            if (initText.startsWith("Effect.fnUntraced")) {
              ensureNamedImport(ctx, norm, "effect", ["Effect"], patch.ruleId, rationale)
              const nextInit = initText.replace(/^Effect\.fnUntraced/, `Effect.fn("${fnEnt.spanName}")`)
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
              ensureNamedImport(ctx, norm, "effect", ["Effect"], patch.ruleId, rationale)
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

export const applyRep07DiscriminantMatchRepair = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  rationale: string,
): void => {
  const rawKey = String(patch.primaryNodeKey).replace(/^EffectFn:/, "")
  const filePart = rawKey.split("#")[0] ?? ""
  const { sf, norm } = getOrCreateSourceFile(ctx, filePart, {
    requireExisting: true,
    ruleId: patch.ruleId,
  })

  const sourceText = sf.getFullText()
  const root = parse(Lang.TypeScript, sourceText).root()
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
        const replacement =
          elseRaw.length > 0
            ? `return match(${subject}).with({ _tag: "${literalTag}" }, () => ${thenRet}).with(P._, () => ${elseRet}).exhaustive()`
            : `return match(${subject}).with({ _tag: "${literalTag}" }, () => ${thenRet}).exhaustive()`
        sf.replaceWithText(sourceText.replace(text, replacement))
        ensureNamedImport(
          ctx,
          norm,
          "ts-pattern",
          elseRaw.length > 0 ? ["match", "P"] : ["match"],
          patch.ruleId,
          rationale,
        )
        rewrittenSnippet = replacement
        break
      }
    }
  }

  if (rewrittenSnippet === undefined) {
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
        ensureNamedImport(ctx, norm, "ts-pattern", ["match"], patch.ruleId, rationale)
        rewrittenSnippet = replacement
        break
      }
    }
  }

  if (rewrittenSnippet === undefined) {
    for (const callExpr of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = callExpr.getExpression()
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "otherwise") {
        continue
      }
      const receiver = callee.getExpression()
      const receiverText = receiver.getText()
      if (
        receiverText.startsWith("match(") &&
        (receiverText.includes("_tag") || receiverText.includes("kind"))
      ) {
        const replacement = `${receiverText}.exhaustive()`
        callExpr.replaceWithText(replacement)
        ensureNamedImport(ctx, norm, "ts-pattern", ["match"], patch.ruleId, rationale)
        rewrittenSnippet = replacement
        break
      }
    }
  }

  if (rewrittenSnippet === undefined) {
    return
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

export const applyRep08DecodeBoundaryRepair = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  rationale: string,
): void => {
  for (const insEnt of patch.insertedEntityNodes) {
    match(insEnt)
      .with({ _tag: "TaggedError" }, (errEnt) => projectTaggedErrorNode(ctx, errEnt, patch.ruleId, rationale))
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
  const filePart = rawKey.split("#")[0] ?? ""
  const { sf, norm } = getOrCreateSourceFile(ctx, filePart, {
    requireExisting: true,
    ruleId: patch.ruleId,
  })

  const root = parse(Lang.TypeScript, sf.getFullText()).root()
  const makeMatches = root.findAll("$BRAND.make($ARG)")
  if (makeMatches.length === 0) return

  ensureNamedImport(ctx, norm, "effect", ["Effect", "Schema"], patch.ruleId, rationale)
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

  const snippet = isGenerator
    ? `yield* Schema.decodeUnknownEffect(${brandName})(${argText})`
    : `Effect.runSync(Schema.decodeUnknownEffect(${brandName})(${argText}))`

  sf.replaceWithText(sf.getFullText().replace(matchText, snippet))
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

export const applyRep11DeleteUnusedService = (
  ctx: ProjectorContext,
  patch: GraphPatch,
  initialGraph?: HarnessGraph,
  rationale: string = "harness:SPEC-0008",
): void => {
  for (const delKey of patch.deletedEntityKeys) {
    let targetFile = ""
    const rawKey = String(delKey).replace(/^ServiceTag:/, "")
    const hashParts = rawKey.split("#")
    if (hashParts.length >= 2 && hashParts[0]!.endsWith(".ts")) {
      targetFile = hashParts[0]!
    }
    let svcIdent = sanitizeIdentifier(hashParts[hashParts.length - 1] ?? rawKey)
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
    if (targetFile.length === 0) targetFile = "libs/service/src/ports.ts"
    const { sf, norm } = getOrCreateSourceFile(ctx, targetFile, { requireExisting: true, ruleId: patch.ruleId })
    const cls = sf.getClass(svcIdent)
    if (cls !== undefined) cls.remove()
    const varDecl = sf.getVariableDeclaration(svcIdent)
    if (varDecl !== undefined) varDecl.getVariableStatement()?.remove()
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

export const coProjectBarrelExports = (
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

    const scopedMatch = relFile.match(/^(libs\/[^/]+\/(?:contract|service|domain|core|infra)\/src)\/(.+)\.(?:ts|tsx)$/)
    const flatMatch = relFile.match(/^(libs\/(?:contract|service|domain|core|infra)\/src)\/(.+)\.(?:ts|tsx)$/)
    const baseSrcDir = scopedMatch?.[1] ?? flatMatch?.[1]
    const subModulePath = scopedMatch?.[2] ?? flatMatch?.[2]
    if (baseSrcDir === undefined || subModulePath === undefined || subModulePath === "index") {
      continue
    }

    const barrelRelPath = `${baseSrcDir}/index.ts`
    const moduleSpecifier = `./${subModulePath}.js`
    const { sf: barrelSf, norm: barrelNorm } = getOrCreateSourceFile(ctx, barrelRelPath)

    const existingExportDecls = barrelSf.getExportDeclarations()
    const hasWildcardReExport = existingExportDecls.some(
      (d) =>
        (d.getModuleSpecifierValue() === moduleSpecifier || d.getModuleSpecifierValue() === `./${subModulePath}.ts`) &&
        !d.hasNamedExports() &&
        !d.isNamespaceExport(),
    )
    if (hasWildcardReExport) continue

    const existingNamedDecl = existingExportDecls.find(
      (d) =>
        (d.getModuleSpecifierValue() === moduleSpecifier || d.getModuleSpecifierValue() === `./${subModulePath}.ts`) &&
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
      barrelSf.addExportDeclaration({ moduleSpecifier, namedExports: sortedSymbols })
      newlyExported.push(...sortedSymbols)
    }

    if (newlyExported.length > 0) {
      ctx.modifiedFiles.add(barrelNorm)
      ctx.operations.push({
        ruleId,
        engine: CodeModEngineKind.make("ts-morph"),
        action: CodeModActionKind.make("insert-declaration"),
        targetFile: TargetFilePath.make(barrelNorm),
        snippet: TypeScriptSnippet.make(`export { ${newlyExported.join(", ")} } from "${moduleSpecifier}"`),
        rationale: SpecificationRef.make(rationale),
      })
    }
  }
}

export const projectPatchesToInMemoryWorkspace = (
  repoRoot: string,
  targetGraph: HarnessGraph,
  patches: ReadonlyArray<GraphPatch>,
  initialGraph?: HarnessGraph,
  existingFiles?: Readonly<Record<string, string>>,
  hostIo?: SyncHostIo,
): {
  readonly operations: ReadonlyArray<AstCodeModOperation>
  readonly overlays: ReadonlyArray<ShadowFileOverlay>
  readonly overlayMap: Readonly<Record<string, string>>
  readonly pendingError: GraphProjectorError | undefined
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

  for (const p of patches) {
    for (const ent of p.insertedEntityNodes) targetEntitiesByKey.set(getNodeKey(ent), ent)
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
    if (typeof f !== "string" || f.trim().length === 0) continue
    const validated = validateRelPath(repoRoot, f, undefined, hostIo)
    if (!validated.ok) continue
    const norm = validated.relPath
    if (!initialContents.has(norm)) {
      const diskContent = readInitialFileContent(repoRoot, norm, existingFiles, hostIo)
      if (diskContent !== undefined) initialContents.set(norm, diskContent)
    }
    const barrelMatch = norm.match(/^(libs\/(?:[^/]+\/)?(?:contract|service|domain|core|infra)\/src)\//)
    if (barrelMatch?.[1] !== undefined) {
      const barrelRel = `${barrelMatch[1]}/index.ts`
      if (!initialContents.has(barrelRel)) {
        const diskBarrel = readInitialFileContent(repoRoot, barrelRel, existingFiles, hostIo)
        if (diskBarrel !== undefined) initialContents.set(barrelRel, diskBarrel)
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
    if (ctx.pendingError !== undefined) break
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

    for (const insEnt of patch.insertedEntityNodes) {
      match(insEnt)
        .with({ _tag: "SchemaDef" }, (n) => projectSchemaDefNode(ctx, n, patch.ruleId, rationale))
        .with({ _tag: "TaggedError" }, (n) => projectTaggedErrorNode(ctx, n, patch.ruleId, rationale))
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

    for (const insEnt of patch.insertedEntityNodes) {
      match(insEnt)
        .with({ _tag: "EffectFn" }, (n) =>
          projectEffectFnNode(ctx, n, patch.ruleId, rationale, {
            requireExisting: String(patch.ruleId) === "REP-04a" || String(patch.ruleId) === "REP-04b",
          }),
        )
        .with({ _tag: "ServiceLayer" }, (n) => projectServiceLayerNode(ctx, n, patch.ruleId, rationale))
        .with({ _tag: "VitestCase" }, (n) => projectVitestCaseNode(ctx, n, patch.ruleId, rationale))
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

    const touchedCallerKeys = new Set<string>()
    for (const edge of [...patch.insertedRoleEdges, ...patch.deletedRoleEdges]) {
      const relEdges = ctx.targetEdgesByRelId.get(edge.relationId) ?? []
      for (const re of relEdges) {
        match<string>(re.role).with("caller", () => { touchedCallerKeys.add(re.entityKey) }).otherwise(() => {})
      }
    }
    for (const callerKey of touchedCallerKeys) {
      const callerEnt = ctx.targetEntitiesByKey.get(callerKey)
      if (callerEnt !== undefined && !patch.insertedEntityNodes.some((n) => getNodeKey(n) === callerKey)) {
        match(callerEnt)
          .with({ _tag: "EffectFn" }, (fnEnt) =>
            projectEffectFnNode(ctx, fnEnt, patch.ruleId, rationale, {
              requireExisting: String(patch.ruleId) === "REP-04a" || String(patch.ruleId) === "REP-04b",
            }),
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

    for (const insRel of patch.insertedRelationNodes) {
      match(insRel)
        .with({ _tag: "MigrationTuple" }, (migRel) => projectMigrationTupleRelation(ctx, migRel, patch.ruleId, rationale))
        .with(
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          () => undefined,
        )
        .exhaustive()
    }

    coProjectBarrelExports(ctx, patch.ruleId, rationale)
  }

  const overlays: Array<ShadowFileOverlay> = []
  const overlayMap: Record<string, string> = {}
  const sortedModified = Array.from(ctx.modifiedFiles).sort()
  for (const relFile of sortedModified) {
    if (relFile === "__invalid_target__.ts") continue
    const sf = ctx.project.getSourceFile(`/${relFile}`)
    if (sf === undefined) continue
    const content = sf.getFullText()
    overlays.push({ targetFile: TargetFilePath.make(relFile), content: TypeScriptSnippet.make(content) })
    overlayMap[relFile] = content
  }

  return {
    operations: ctx.operations,
    overlays,
    overlayMap,
    pendingError: ctx.pendingError,
  }
}
