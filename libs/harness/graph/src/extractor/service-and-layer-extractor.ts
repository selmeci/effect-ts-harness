import * as path from "node:path"
import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph"
import {
  type BranchingViolation,
  type EffectFnNode,
  type LayerKind,
  type PackageTag,
  type SchemaDefNode,
  type ServiceLayerNode,
  type ServiceTagNode,
  type TaggedErrorNode,
} from "../model.js"
import {
  decomposeType,
  decomposeTypeNode,
  resolveImportSpecToRelFile,
  sha256Hex,
} from "./extractor-types-and-helpers.js"
import {
  type FileGraphFragment,
  type SourceFileInput,
  type TypeScriptProgramSession,
  computeDeclHash,
  extractModuleSpecifiers,
  saveFileGraphFragmentsToDisk,
} from "./compiler-session.js"

export const extractServicesAndErrors = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  services: Array<ServiceTagNode>,
  errors: Array<TaggedErrorNode>,
  classNameToTagId: Map<string, string>,
  serviceMethodErrors: Map<string, Map<string, Array<string>>>,
): void => {
  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue
    const extClause = cls.getExtends()
    if (!extClause) continue
    const extText = extClause.getText(), clsName = cls.getName() ?? ""

    const extractCallFirstString = (node: Node): string | null => {
      for (const c of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const a = c.getArguments()[0]
        if (a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a))) return a.getText().replace(/^["'`]|["'`]$/g, "")
      }
      return null
    }

    if (extText.includes("Context.Service") || extText.includes("Service<")) {
      const tagId = extractCallFirstString(extClause) ?? clsName
      classNameToTagId.set(clsName, tagId)
      classNameToTagId.set(tagId, tagId)
      services.push({ _tag: "ServiceTag", tagId, name: clsName, packageTag: filePkgTag, file: relPath, line: cls.getStartLineNumber() })

      const typeLiteral = extClause.getFirstDescendantByKind(SyntaxKind.TypeLiteral)
      if (typeLiteral) {
        const methodsMap = new Map<string, Array<string>>()
        for (const member of typeLiteral.getMembers()) {
          const mName = Node.isPropertySignature(member) ? member.getName() : member.getFirstChildByKind(SyntaxKind.Identifier)?.getText()
          if (!mName) continue
          const effectRef = member.getFirstDescendant((n) => n.getKind() === SyntaxKind.TypeReference && n.getText().includes("Effect"))
          if (effectRef && Node.isTypeReference(effectRef)) {
            const typeArgs = effectRef.getTypeArguments()
            if (typeArgs.length >= 2 && typeArgs[1]) methodsMap.set(mName, decomposeTypeNode(typeArgs[1]))
          }
        }
        serviceMethodErrors.set(clsName, methodsMap)
        if (tagId !== clsName) serviceMethodErrors.set(tagId, methodsMap)
      }
    }

    if (
      extText.includes("Data.TaggedError") || extText.includes("TaggedError(") ||
      extText.includes("TaggedError<") || extText.includes("Schema.TaggedError") ||
      extText.includes("Schema.TaggedErrorClass") || extText.includes("TaggedErrorClass(")
    ) {
      const errorTag = extractCallFirstString(extClause) ?? clsName
      errors.push({ _tag: "TaggedError", errorTag, file: relPath, line: cls.getStartLineNumber() })
    }
  }
}

export const extractLayers = (
  sourceFile: SourceFile,
  relPath: string,
  filePkgTag: PackageTag,
  layers: Array<ServiceLayerNode>,
  providesService: Array<{ readonly layerQualname: string; readonly tagId: string }>,
  layerRequires: Array<{ readonly layerQualname: string; readonly tagId: string }>,
  classNameToTagId: Map<string, string>,
  referencedServices: Set<string>,
): void => {
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    if (!varDecl.isExported()) continue
    const varName = varDecl.getName()
    const typeNode = varDecl.getTypeNode()
    const init = varDecl.getInitializer()
    const typeText = typeNode?.getText() ?? ""
    const initText = init?.getText() ?? ""

    const isLayer =
      typeText.includes("Layer") ||
      initText.startsWith("Layer.") ||
      (init !== undefined && Node.isCallExpression(init) && init.getExpression().getText().startsWith("Layer."))

    if (!isLayer) continue

    const qualname = `${relPath}#${varName}`
    const layerKind: LayerKind = /test/i.test(varName) ? "test" : /emulated/i.test(varName) ? "emulated" : /infra/i.test(varName) ? "infra" : "live"
    layers.push({ _tag: "ServiceLayer", qualname, layerKind, packageTag: filePkgTag, file: relPath, line: varDecl.getStartLineNumber() })

    const rOutMembers = new Set<string>(), rInMembers = new Set<string>()
    if (typeNode && Node.isTypeReference(typeNode)) {
      const a = typeNode.getTypeArguments()
      if (a[0]) for (const m of decomposeTypeNode(a[0])) rOutMembers.add(m)
      if (a[2]) for (const m of decomposeTypeNode(a[2])) rInMembers.add(m)
    }
    const typeArgs = varDecl.getType().getTypeArguments()
    if (typeArgs.length >= 3) {
      if (typeArgs[0]) for (const m of decomposeType(typeArgs[0])) rOutMembers.add(m)
      if (typeArgs[2]) for (const m of decomposeType(typeArgs[2])) rInMembers.add(m)
    }
    if (rOutMembers.size === 0 && rInMembers.size === 0 && init && Node.isCallExpression(init)) {
      const args = init.getArguments()
      if (args[0]?.getKind() === SyntaxKind.Identifier) rOutMembers.add(args[0].getText())
      for (const y of init.getDescendantsOfKind(SyntaxKind.YieldExpression)) {
        const expr = y.getExpression()
        if (expr && expr.getKind() === SyntaxKind.Identifier) rInMembers.add(expr.getText())
      }
    }

    for (const rawROut of rOutMembers) {
      const rOut = classNameToTagId.get(rawROut) ?? rawROut
      providesService.push({ layerQualname: qualname, tagId: rOut })
      referencedServices.add(rOut)
    }
    for (const rawRIn of rInMembers) {
      const rIn = classNameToTagId.get(rawRIn) ?? rawRIn
      layerRequires.push({ layerQualname: qualname, tagId: rIn })
      referencedServices.add(rIn)
    }
  }
}

export const buildFileGraphFragment = (
  relPath: string,
  packageTag: PackageTag,
  contentSha256: string,
  declHash: string,
  importedSpecs: ReadonlyArray<string>,
  fns: ReadonlyArray<EffectFnNode>,
  services: ReadonlyArray<ServiceTagNode>,
  layers: ReadonlyArray<ServiceLayerNode>,
  errors: ReadonlyArray<TaggedErrorNode>,
  schemas: ReadonlyArray<SchemaDefNode>,
  requiresService: ReadonlyArray<{ readonly callerQualname: string; readonly tagId: string }>,
  failsWith: ReadonlyArray<{ readonly callerQualname: string; readonly errorTag: string }>,
  providesService: ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }>,
  layerRequires: ReadonlyArray<{ readonly layerQualname: string; readonly tagId: string }>,
  branchingViolations: ReadonlyArray<BranchingViolation>,
): FileGraphFragment => {
  const fileQualPrefix = `${relPath}#`
  return {
    filePath: relPath,
    packageTag,
    contentSha256,
    declHash,
    importedSpecs,
    fns: fns.filter((fn) => fn.file === relPath),
    services: services.filter((s) => s.file === relPath),
    layers: layers.filter((l) => l.file === relPath),
    errors: errors.filter((e) => e.file === relPath),
    schemas: schemas.filter((s) => s.file === relPath),
    requiresService: requiresService.filter((r) => r.callerQualname.startsWith(fileQualPrefix)),
    failsWith: failsWith.filter((fw) => fw.callerQualname.startsWith(fileQualPrefix)),
    providesService: providesService.filter((p) => p.layerQualname.startsWith(fileQualPrefix)),
    layerRequires: layerRequires.filter((lr) => lr.layerQualname.startsWith(fileQualPrefix)),
    branchingViolations: branchingViolations.filter((bv) => bv.file === relPath),
  }
}

export const aggregateFileGraphFragments = (
  session: TypeScriptProgramSession,
  sortedRelPaths: ReadonlyArray<string>,
  target: {
    readonly fns: Array<EffectFnNode>
    readonly services: Array<ServiceTagNode>
    readonly layers: Array<ServiceLayerNode>
    readonly errors: Array<TaggedErrorNode>
    readonly schemas: Array<SchemaDefNode>
    readonly requiresService: Array<{ readonly callerQualname: string; readonly tagId: string }>
    readonly failsWith: Array<{ readonly callerQualname: string; readonly errorTag: string }>
    readonly providesService: Array<{ readonly layerQualname: string; readonly tagId: string }>
    readonly layerRequires: Array<{ readonly layerQualname: string; readonly tagId: string }>
    readonly branchingViolations: Array<BranchingViolation>
    readonly referencedServices: Set<string>
    readonly referencedErrors: Set<string>
    readonly classNameToTagId: Map<string, string>
  },
): void => {
  const seenSchemaNames = new Set<string>()
  for (const relPath of sortedRelPaths) {
    const frag = session.fileFragmentCache.get(relPath)
    if (!frag) continue
    for (const s of frag.services ?? []) {
      target.classNameToTagId.set(s.name, s.tagId)
      target.classNameToTagId.set(s.tagId, s.tagId)
      target.services.push(s)
    }
    for (const e of frag.errors ?? []) {
      target.errors.push(e)
    }
    for (const sc of frag.schemas ?? []) {
      if (!seenSchemaNames.has(sc.schemaName)) {
        seenSchemaNames.add(sc.schemaName)
        target.schemas.push(sc)
      }
    }
  }

  for (const relPath of sortedRelPaths) {
    const frag = session.fileFragmentCache.get(relPath)
    if (!frag) continue
    target.fns.push(...frag.fns)
    target.layers.push(...frag.layers)
    for (const r of frag.requiresService) {
      const tagId = target.classNameToTagId.get(r.tagId) ?? r.tagId
      target.requiresService.push({ callerQualname: r.callerQualname, tagId })
      target.referencedServices.add(tagId)
    }
    for (const fw of frag.failsWith) {
      target.failsWith.push(fw)
      target.referencedErrors.add(fw.errorTag)
    }
    for (const p of frag.providesService) {
      const tagId = target.classNameToTagId.get(p.tagId) ?? p.tagId
      target.providesService.push({ layerQualname: p.layerQualname, tagId })
      target.referencedServices.add(tagId)
    }
    for (const lr of frag.layerRequires) {
      const tagId = target.classNameToTagId.get(lr.tagId) ?? lr.tagId
      target.layerRequires.push({ layerQualname: lr.layerQualname, tagId })
      target.referencedServices.add(tagId)
    }
    target.branchingViolations.push(...frag.branchingViolations)
  }
}

export const autoRegisterReferencedEntities = (
  services: Array<ServiceTagNode>,
  errors: Array<TaggedErrorNode>,
  referencedServices: ReadonlySet<string>,
  referencedErrors: ReadonlySet<string>,
  classNameToTagId: ReadonlyMap<string, string>,
): void => {
  const existingServiceTags = new Set(services.map((s) => s.tagId))
  for (const rawSvc of referencedServices) {
    const svc = classNameToTagId.get(rawSvc) ?? rawSvc
    if (!existingServiceTags.has(svc)) {
      existingServiceTags.add(svc)
      const isInfra = /^(Cloudflare|Alchemy|Drizzle|Provider|Binding|SqlClient|SqliteClient|SqlStorage)\b/.test(svc)
      services.push({
        _tag: "ServiceTag",
        tagId: svc,
        name: svc,
        packageTag: isInfra ? "infra" : "service",
        file: "",
      })
    }
  }

  const existingErrors = new Set(errors.map((e) => e.errorTag))
  for (const err of referencedErrors) {
    if (!existingErrors.has(err)) {
      existingErrors.add(err)
      errors.push({
        _tag: "TaggedError",
        errorTag: err,
        file: "",
      })
    }
  }
}

export const syncSessionCacheAndProject = (
  session: TypeScriptProgramSession | undefined,
  project: Project,
  repoRoot: string,
  fileMap: Map<string, SourceFileInput>,
  currentShas: Map<string, string>,
  currentDeclHashes: Map<string, string>,
  currentSpecs: Map<string, ReadonlyArray<string>>,
  filesToReextract: Set<string>,
  declChangedFiles: Set<string>,
  dynamicPaths: Record<string, Array<string>>,
): void => {
  for (const [rel, f] of fileMap.entries()) {
    const absPath = path.isAbsolute(f.filePath) ? f.filePath : path.resolve(repoRoot, f.filePath)
    const sha = sha256Hex(f.content)
    currentShas.set(rel, sha)
    const prev = session?.sourceFileCache.get(rel), prevFrag = session?.fileFragmentCache.get(rel)
    if (session && prev && prevFrag && prev.contentSha256 === sha && (prev.packageTag ?? f.packageTag) === f.packageTag) {
      session.warmHitCount++; currentDeclHashes.set(rel, prev.declHash); currentSpecs.set(rel, prev.importedSpecs)
    } else {
      let sf = project.getSourceFile(absPath)
      if (sf !== undefined) sf.replaceWithText(f.content)
      else sf = project.createSourceFile(absPath, f.content, { overwrite: true })
      const csf = sf.compilerNode, declHash = computeDeclHash(csf), specs = extractModuleSpecifiers(csf)
      currentDeclHashes.set(rel, declHash); currentSpecs.set(rel, specs); filesToReextract.add(rel)
      if (session) {
        if (prev && (prev.packageTag ?? f.packageTag) === f.packageTag) {
          if (prev.declHash === declHash) session.signatureCleanCutoffCount++
          else declChangedFiles.add(rel)
        } else declChangedFiles.add(rel)
        session.sourceFileCache.set(rel, { packageTag: f.packageTag, contentSha256: sha, declHash, sourceFile: csf, importedSpecs: specs })
      }
    }
  }

  if (session) {
    const deletedRels = new Set<string>()
    for (const cachedRel of Array.from(session.sourceFileCache.keys())) {
      if (!fileMap.has(cachedRel)) {
        deletedRels.add(cachedRel)
        for (const dep of session.reverseImportsByFile.get(cachedRel) ?? []) if (fileMap.has(dep)) { filesToReextract.add(dep); declChangedFiles.add(dep) }
        session.sourceFileCache.delete(cachedRel); session.fileFragmentCache.delete(cachedRel)
        const oldSf = project.getSourceFile(path.resolve(repoRoot, cachedRel))
        if (oldSf) project.removeSourceFile(oldSf)
      }
    }
    if (deletedRels.size > 0) {
      const augmentedFileMap = new Map<string, unknown>(fileMap)
      for (const delRel of deletedRels) augmentedFileMap.set(delRel, true)
      for (const [rel, specs] of currentSpecs.entries()) {
        for (const spec of specs) {
          const target = resolveImportSpecToRelFile(rel, spec, repoRoot, augmentedFileMap, dynamicPaths)
          if (target !== null && deletedRels.has(target)) { filesToReextract.add(rel); declChangedFiles.add(rel) }
        }
      }
    }
    session.reverseImportsByFile.clear()
    for (const [rel, specs] of currentSpecs.entries()) {
      for (const spec of specs) {
        const target = resolveImportSpecToRelFile(rel, spec, repoRoot, fileMap, dynamicPaths)
        if (target && target !== rel) {
          let s = session.reverseImportsByFile.get(target)
          if (!s) { s = new Set<string>(); session.reverseImportsByFile.set(target, s) }
          s.add(rel)
        }
      }
    }
    if (declChangedFiles.size > 0) {
      const q = Array.from(declChangedFiles), visited = new Set(declChangedFiles)
      while (q.length > 0) {
        for (const dep of session.reverseImportsByFile.get(q.shift()!) ?? []) {
          filesToReextract.add(dep); if (!visited.has(dep)) { visited.add(dep); q.push(dep) }
        }
      }
    }
    for (const rel of fileMap.keys()) if (!filesToReextract.has(rel) && !session.fileFragmentCache.has(rel)) filesToReextract.add(rel)
    const needed = new Set(filesToReextract)
    if (filesToReextract.size > 0) {
      for (const rel of filesToReextract) {
        const m = rel.match(/^libs\/([^/]+)\//)
        if (m && m[1] && m[1] !== "harness") for (const k of fileMap.keys()) if (k.startsWith(`libs/${m[1]}/`)) needed.add(k)
      }
      const fwd = Array.from(needed)
      while (fwd.length > 0) {
        const curr = fwd.shift()!
        for (const spec of currentSpecs.get(curr) ?? []) {
          const target = resolveImportSpecToRelFile(curr, spec, repoRoot, fileMap, dynamicPaths)
          if (target && !needed.has(target)) { needed.add(target); fwd.push(target) }
        }
      }
      for (const rel of needed) {
        const f = fileMap.get(rel)
        if (f) {
          const p = path.isAbsolute(f.filePath) ? f.filePath : path.resolve(repoRoot, f.filePath)
          if (!project.getSourceFile(p)) project.createSourceFile(p, f.content, { overwrite: true })
        }
      }
    }
    session.lastReextractedFiles = Array.from(filesToReextract)
  }
}

export const commitSessionFragments = (
  session: TypeScriptProgramSession,
  filesToReextract: ReadonlySet<string>,
  fileMap: ReadonlyMap<string, SourceFileInput>,
  currentShas: ReadonlyMap<string, string>,
  currentDeclHashes: ReadonlyMap<string, string>,
  currentSpecs: ReadonlyMap<string, ReadonlyArray<string>>,
  repoRoot: string,
  target: Parameters<typeof aggregateFileGraphFragments>[2],
  hasOverlays: boolean,
): void => {
  for (const rel of filesToReextract) {
    const f = fileMap.get(rel)
    if (!f) continue
    const sha = currentShas.get(rel) ?? sha256Hex(f.content), declHash = currentDeclHashes.get(rel) ?? computeDeclHash(f.content), specs = currentSpecs.get(rel) ?? []
    session.fileFragmentCache.set(rel, buildFileGraphFragment(rel, f.packageTag, sha, declHash, specs, target.fns, target.services, target.layers, target.errors, target.schemas, target.requiresService, target.failsWith, target.providesService, target.layerRequires, target.branchingViolations))
  }
  target.fns.length = 0; target.services.length = 0; target.layers.length = 0; target.errors.length = 0; target.schemas.length = 0
  target.requiresService.length = 0; target.failsWith.length = 0; target.providesService.length = 0; target.layerRequires.length = 0; target.branchingViolations.length = 0
  target.referencedServices.clear(); target.referencedErrors.clear(); target.classNameToTagId.clear()
  aggregateFileGraphFragments(session, Array.from(fileMap.keys()).sort((a, b) => a.localeCompare(b)), target)
  if (filesToReextract.size > 0 && !hasOverlays) saveFileGraphFragmentsToDisk(repoRoot, session)
}
