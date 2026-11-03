import * as fs from "node:fs"
import * as path from "node:path"
import type { PatternDocNode } from "./model.js"

export const loadPatternDocs = (repoRoot: string): ReadonlyArray<PatternDocNode> => {
  const dirPath = path.join(repoRoot, "agent-patterns")
  if (!fs.existsSync(dirPath)) {
    return []
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const docs: Array<PatternDocNode> = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") {
      continue
    }

    const slug = entry.name.slice(0, -3)
    const filePath = path.join(dirPath, entry.name)
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split(/\r?\n/)

    let foundTitle = false
    const summaryLines: Array<string> = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!foundTitle) {
        if (trimmed.startsWith("# ")) {
          foundTitle = true
        }
        continue
      }

      if (trimmed.length === 0) {
        if (summaryLines.length > 0) {
          break
        }
        continue
      }

      if (trimmed.startsWith("#")) {
        break
      }

      summaryLines.push(trimmed)
    }

    const summary = summaryLines.join(" ")

    docs.push({
      _tag: "PatternDoc",
      slug,
      path: `agent-patterns/${entry.name}`,
      summary,
    })
  }

  return docs.sort((a, b) => a.slug.localeCompare(b.slug))
}
