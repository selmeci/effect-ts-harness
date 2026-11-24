import * as path from "node:path"
import { compareCodeUnits } from "@harness/contract"
import type { SyncHostIo } from "@harness/service/host-io"
import type { PatternDocNode } from "./model.js"

const MAX_PATTERN_SUMMARY_CHARS = 1600
const MAX_LEAD_PARAGRAPHS = 4

export const loadPatternDocs = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ReadonlyArray<PatternDocNode> => {
  const dirPath = path.join(repoRoot, "agent-patterns")
  if (!hostIo.existsSync(dirPath)) {
    return []
  }

  const entries = hostIo.readdirSync(dirPath)
  const docs: Array<PatternDocNode> = []

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".md") || entry.name === "README.md") {
      continue
    }

    const slug = entry.name.slice(0, -3)
    const filePath = path.join(dirPath, entry.name)
    const content = hostIo.readTextSync(filePath)
    const lines = content.split(/\r?\n/)

    let title = ""
    const headings: Array<string> = []
    const paragraphs: Array<string> = []
    const spanSet = new Set<string>()
    const tagSet = new Set<string>()
    let currentPara: Array<string> = []
    let inFence: boolean = false
    let fenceChar = ""
    let fenceLength = 0
    let capturingParagraph = false

    const flushParagraph = (stopCapture = false) => {
      if (currentPara.length > 0) {
        if (paragraphs.length < MAX_LEAD_PARAGRAPHS) {
          paragraphs.push(currentPara.join(" ").trim())
        }
        currentPara = []
        capturingParagraph = false
      }
      if (stopCapture) {
        capturingParagraph = false
      }
    }

    for (const line of lines) {
      const trimmed = line.trim()
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/)
      if (fenceMatch) {
        const marker = fenceMatch[1]!
        const rest = fenceMatch[2] ?? ""
        const ch = marker[0] ?? "`"
        if (!inFence) {
          flushParagraph(true)
          inFence = true
          fenceChar = ch
          fenceLength = marker.length
          continue
        }
        if (ch === fenceChar && marker.length >= fenceLength && rest.trim().length === 0) {
          inFence = false
          fenceChar = ""
          fenceLength = 0
          continue
        }
      }
      if (inFence) continue

      for (const m of trimmed.matchAll(/`([A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)+)`/g)) {
        if (m[1]) spanSet.add(m[1])
      }
      for (const m of trimmed.matchAll(
        /`(@harness\/[A-Za-z0-9_/-]+|[A-Za-z][A-Za-z0-9]+Error)`/g,
      )) {
        if (m[1]) tagSet.add(m[1])
      }

      if (trimmed.startsWith("# ")) {
        flushParagraph(true)
        if (title === "") {
          title = trimmed.slice(2).trim()
          capturingParagraph = true
        }
        continue
      }

      if (/^#{2,3}\s+/.test(trimmed)) {
        flushParagraph(true)
        const headingText = trimmed.replace(/^#{2,3}\s+/, "").trim()
        if (headingText.length > 0) {
          headings.push(headingText)
          capturingParagraph = paragraphs.length < MAX_LEAD_PARAGRAPHS
        }
        continue
      }

      if (trimmed.length === 0) {
        flushParagraph()
        continue
      }

      if (capturingParagraph && !trimmed.startsWith("|")) {
        currentPara.push(trimmed)
      }
    }
    flushParagraph()

    const combinedSummary = [title, headings.length > 0 ? headings.join(" · ") : "", ...paragraphs]
      .filter((part) => part.length > 0)
      .join(" — ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_PATTERN_SUMMARY_CHARS)
      .trim()

    const coveredSpans = [...spanSet].sort(compareCodeUnits)
    const coveredTags = [...tagSet].sort(compareCodeUnits)

    docs.push({
      _tag: "PatternDoc",
      slug,
      path: `agent-patterns/${entry.name}`,
      summary: combinedSummary.length > 0 ? combinedSummary : slug,
      ...(title.length > 0 ? { title } : {}),
      ...(headings.length > 0 ? { headings } : {}),
      ...(coveredSpans.length > 0 ? { coveredSpans } : {}),
      ...(coveredTags.length > 0 ? { coveredTags } : {}),
    })
  }

  return docs.sort((a, b) => compareCodeUnits(a.slug, b.slug))
}
