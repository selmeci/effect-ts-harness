import { ts } from "ts-morph"
import { hasExportModifier, sha256Hex } from "./extractor-types-and-helpers.js"

export const emitDeclarationSignatureText = (sourceFile: ts.SourceFile): string => {
  const parts: Array<string> = []

  const extractStubSignatures = (node: ts.Node): Array<string> => {
    const stubs: Array<string> = []
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sourceFile)
        if ((callee === "stub" || callee.endsWith(".stub")) && n.typeArguments !== undefined) {
          stubs.push(`stub<${n.typeArguments.map((t) => t.getText(sourceFile)).join(",")}>`)
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(node)
    return stubs
  }

  const formatFnLikeSignature = (
    fn: ts.FunctionExpression | ts.ArrowFunction | ts.FunctionDeclaration,
    hasOuterExplicitType: boolean = false,
  ): string => {
    const typeParams = fn.typeParameters
      ? `<${fn.typeParameters.map((tp) => tp.getText(sourceFile)).join(",")}>`
      : ""
    const params = fn.parameters
      .map(
        (p) =>
          `${p.name.getText(sourceFile)}${p.questionToken ? "?" : ""}${p.type ? `: ${p.type.getText(sourceFile)}` : ""}`,
      )
      .join(",")
    const retType = fn.type ? `: ${fn.type.getText(sourceFile)}` : ""
    const stubs = fn.body ? extractStubSignatures(fn.body) : []
    const unannotatedBody =
      fn.type === undefined && !hasOuterExplicitType && stubs.length === 0 && fn.body
        ? [fn.body.getText(sourceFile).replace(/\s+/g, " ").trim()]
        : []
    const bodySig = [...stubs, ...unannotatedBody]
    return `(${typeParams}(${params})${retType}${bodySig.length > 0 ? `[${bodySig.join(";")}]` : ""})`
  }

  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt)
    ) {
      parts.push(stmt.getText(sourceFile).trim())
      continue
    }
    if (!hasExportModifier(stmt)) continue
    if (
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      parts.push(stmt.getText(sourceFile).trim())
      continue
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const fnName = stmt.name?.text ?? "default"
      parts.push(`export function ${fnName}${formatFnLikeSignature(stmt, false)}`)
      continue
    }
    if (ts.isClassDeclaration(stmt)) {
      const clsName = stmt.name?.text ?? "AnonymousClass"
      const heritage = stmt.heritageClauses
        ? stmt.heritageClauses.map((h) => h.getText(sourceFile)).join(" ")
        : ""
      const memberSigs = stmt.members.map((m) => {
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
          const mName = m.name ? m.name.getText(sourceFile) : "constructor"
          const params = m.parameters.map((p) => p.getText(sourceFile)).join(",")
          const ret = m.type
            ? `: ${m.type.getText(sourceFile)}`
            : m.body
              ? ` { ${m.body.getText(sourceFile).replace(/\s+/g, " ").trim()} }`
              : ""
          return `${mName}(${params})${ret}`
        }
        return m.getText(sourceFile).trim()
      })
      parts.push(`export class ${clsName} ${heritage} { ${memberSigs.join("; ")} }`)
      continue
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const varName = decl.name.getText(sourceFile)
        const hasVarType = decl.type !== undefined
        const explicitType = hasVarType ? `: ${decl.type.getText(sourceFile)}` : ""
        const init = decl.initializer
        if (!init) {
          parts.push(`export const ${varName}${explicitType}`)
          continue
        }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          parts.push(
            `export const ${varName}${explicitType} = ${formatFnLikeSignature(init, hasVarType)}`,
          )
          continue
        }
        if (ts.isCallExpression(init)) {
          const outerCallee = init.expression
          if (ts.isCallExpression(outerCallee)) {
            const innerText = outerCallee.expression.getText(sourceFile)
            if (innerText === "Effect.fn" || innerText === "Effect.fnUntraced") {
              const spanArg = outerCallee.arguments[0]?.getText(sourceFile) ?? ""
              const fnArg = init.arguments[0]
              if (fnArg && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
                parts.push(
                  `export const ${varName}${explicitType} = ${innerText}(${spanArg})${formatFnLikeSignature(fnArg, hasVarType)}`,
                )
                continue
              }
            }
          }
          if (
            !ts.isCallExpression(outerCallee) &&
            outerCallee.getText(sourceFile) === "Effect.fnUntraced"
          ) {
            const fnArg = init.arguments[0]
            if (fnArg && (ts.isFunctionExpression(fnArg) || ts.isArrowFunction(fnArg))) {
              parts.push(
                `export const ${varName}${explicitType} = Effect.fnUntraced${formatFnLikeSignature(fnArg, hasVarType)}`,
              )
              continue
            }
          }
        }
        parts.push(`export const ${varName}${explicitType} = ${init.getText(sourceFile).trim()}`)
      }
    }
  }

  return parts.join("\n")
}

export const computeDeclHash = (sourceFileOrContent: ts.SourceFile | string): string => {
  const sf =
    typeof sourceFileOrContent === "string"
      ? ts.createSourceFile("module.ts", sourceFileOrContent, ts.ScriptTarget.Latest, true)
      : sourceFileOrContent
  return sha256Hex(emitDeclarationSignatureText(sf))
}

export const extractModuleSpecifiers = (sourceFile: ts.SourceFile): ReadonlyArray<string> => {
  const specs: Array<string> = []
  for (const stmt of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      specs.push(stmt.moduleSpecifier.text)
    }
  }
  return specs
}
