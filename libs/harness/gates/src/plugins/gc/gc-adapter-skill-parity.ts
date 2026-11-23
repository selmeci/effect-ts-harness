import { join } from "node:path"
import type { SyncHostIo } from "@harness/service/host-io"
import { type GcFinding, readTextOrReport } from "./gc-helpers.js"

export interface AdapterSkillParityClause {
  readonly skillName: string
  readonly heading: string
  readonly requiredMarkers: ReadonlyArray<string>
}

const SWARM_SEAM_HEADING = "### Swarm Seam Checklist (Pre-Review)"
const SWARM_SEAM_MARKERS: ReadonlyArray<string> = [
  "Symmetric Activity & Deferred Codecs",
  "Single-Source Timeout Budgets",
  "WORKFLOW_TIMEOUT_BUDGETS",
  "Fenced Non-Lease Mutations",
  "expectedLeaseEpoch",
  "Differential Replay Parity",
]

const REMEDIATION_AUDIT_HEADING = "### Mandatory Second-Pass Remediation Re-Audit"
const REMEDIATION_AUDIT_MARKERS: ReadonlyArray<string> = [
  "remediationContext",
  "priorSpecialists",
  "maxSeverity",
  "reviewSlices",
  "REVIEW_SLICE_FILE_THRESHOLD",
]

export const ADAPTER_SKILL_PARITY_CLAUSES: ReadonlyArray<AdapterSkillParityClause> = [
  { skillName: "effect-lfg", heading: SWARM_SEAM_HEADING, requiredMarkers: SWARM_SEAM_MARKERS },
  {
    skillName: "executing-effect-stubs",
    heading: SWARM_SEAM_HEADING,
    requiredMarkers: SWARM_SEAM_MARKERS,
  },
  {
    skillName: "effect-code-review",
    heading: REMEDIATION_AUDIT_HEADING,
    requiredMarkers: REMEDIATION_AUDIT_MARKERS,
  },
  {
    skillName: "resolving-effect-review-feedback",
    heading: REMEDIATION_AUDIT_HEADING,
    requiredMarkers: REMEDIATION_AUDIT_MARKERS,
  },
]

const SUBSECTION_BOUNDARY_RE = /^(?:#{1,3}\s+|---\s*$)/

/** Extracts a markdown subsection from `heading` up to the next H1–H3 heading, `---`, or EOF. */
export const extractMarkdownSubsection = (content: string, heading: string): string | undefined => {
  const lines = content.split(/\r?\n/)
  let activeFence: { readonly char: "`" | "~"; readonly len: number } | null = null
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (activeFence === null) {
      const openMatch = /^\s*(?:(`{3,})([^`\r\n]*)|(~{3,})([^\r\n]*))$/.exec(line)
      if (openMatch !== null) {
        const fenceToken = (openMatch[1] ?? openMatch[3])!
        activeFence = {
          char: fenceToken[0] === "~" ? "~" : "`",
          len: fenceToken.length,
        }
        continue
      }
      if (line.trim() === heading) {
        startIdx = i
        break
      }
    } else {
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (
        closeMatch !== null &&
        closeMatch[1]![0] === activeFence.char &&
        closeMatch[1]!.length >= activeFence.len
      ) {
        activeFence = null
      }
    }
  }
  if (startIdx < 0) {
    return undefined
  }
  const collected: Array<string> = [lines[startIdx]!]
  activeFence = null
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (activeFence === null) {
      const openMatch = /^\s*(?:(`{3,})([^`\r\n]*)|(~{3,})([^\r\n]*))$/.exec(line)
      if (openMatch !== null) {
        const fenceToken = (openMatch[1] ?? openMatch[3])!
        activeFence = {
          char: fenceToken[0] === "~" ? "~" : "`",
          len: fenceToken.length,
        }
        collected.push(line)
        continue
      }
      if (SUBSECTION_BOUNDARY_RE.test(line.trim())) {
        break
      }
    } else {
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (
        closeMatch !== null &&
        closeMatch[1]![0] === activeFence.char &&
        closeMatch[1]!.length >= activeFence.len
      ) {
        activeFence = null
      }
    }
    collected.push(line)
  }
  return collected.join("\n").trim()
}

/** Pure parity audit comparing Antigravity and Claude Code subsections for one skill clause. */
export const auditAdapterSkillParityPair = (
  clause: AdapterSkillParityClause,
  antigravityContent: string,
  claudeContent: string,
): ReadonlyArray<GcFinding> => {
  const findings: Array<GcFinding> = []
  const agyPath = `adapters/antigravity/plugins/effect-harness/skills/${clause.skillName}/SKILL.md`
  const claudePath = `adapters/claude-code/skills/${clause.skillName}/SKILL.md`

  const sides = [
    {
      adapterLabel: "Antigravity",
      path: agyPath,
      section: extractMarkdownSubsection(antigravityContent, clause.heading),
    },
    {
      adapterLabel: "Claude Code",
      path: claudePath,
      section: extractMarkdownSubsection(claudeContent, clause.heading),
    },
  ] as const

  for (const side of sides) {
    if (side.section === undefined) {
      findings.push({
        kind: "adapter-skill-parity",
        nodeId: `${side.path}:missing-heading`,
        location: side.path,
        message: `${side.adapterLabel} skill "${side.path}" is missing required parity heading "${clause.heading}".`,
        action: `Add "${clause.heading}" to "${side.path}".`,
      })
    }
  }

  const agySection = sides[0].section
  const claudeSection = sides[1].section
  if (agySection === undefined || claudeSection === undefined) {
    return findings
  }

  for (const marker of clause.requiredMarkers) {
    for (const side of sides) {
      if (!side.section!.includes(marker)) {
        findings.push({
          kind: "adapter-skill-parity",
          nodeId: `${side.path}:missing:${marker}`,
          location: side.path,
          message: `${side.adapterLabel} skill "${side.path}" section "${clause.heading}" is missing required token "${marker}".`,
          action: `Add "${marker}" inside "${clause.heading}" in "${side.path}".`,
        })
      }
    }
  }

  if (agySection !== claudeSection) {
    findings.push({
      kind: "adapter-skill-parity",
      nodeId: `adapter-skill-parity:${clause.skillName}`,
      location: claudePath,
      message: `Adapter skill parity drift between "${agyPath}" and "${claudePath}" under "${clause.heading}".`,
      action: `Synchronize "${clause.heading}" identically across "${agyPath}" and "${claudePath}".`,
    })
  }

  return findings
}

export const checkAdapterSkillParity = (
  repoRoot: string,
  hostIo: SyncHostIo,
  findings: Array<GcFinding>,
): void => {
  const hasHarnessAdaptersOrCli =
    hostIo.existsSync(join(repoRoot, "adapters/antigravity/plugins/effect-harness/skills")) ||
    hostIo.existsSync(join(repoRoot, "adapters/claude-code/skills")) ||
    hostIo.existsSync(join(repoRoot, "apps/harness-cli/package.json"))

  for (const clause of ADAPTER_SKILL_PARITY_CLAUSES) {
    const agyRel = `adapters/antigravity/plugins/effect-harness/skills/${clause.skillName}/SKILL.md`
    const claudeRel = `adapters/claude-code/skills/${clause.skillName}/SKILL.md`
    const agyAbs = join(repoRoot, agyRel)
    const claudeAbs = join(repoRoot, claudeRel)
    const agyExists = hostIo.existsSync(agyAbs)
    const claudeExists = hostIo.existsSync(claudeAbs)

    if (!agyExists && !claudeExists) {
      if (hasHarnessAdaptersOrCli) {
        findings.push({
          kind: "adapter-skill-parity",
          nodeId: `adapter-skill-parity:${clause.skillName}:both-missing`,
          location: agyRel,
          message: `Adapter skill parity failed: missing both "${agyRel}" and "${claudeRel}" for "${clause.skillName}".`,
          action: `Restore matching "${agyRel}" and "${claudeRel}" for "${clause.skillName}".`,
        })
      }
      continue
    }
    if (!agyExists || !claudeExists) {
      const missingRel = !agyExists ? agyRel : claudeRel
      findings.push({
        kind: "adapter-skill-parity",
        nodeId: `${missingRel}:missing-counterpart`,
        location: missingRel,
        message: `Adapter skill parity failed: missing counterpart "${missingRel}".`,
        action: `Restore matching "${missingRel}" for "${clause.skillName}".`,
      })
      continue
    }

    const agyText = readTextOrReport(agyAbs, hostIo, repoRoot, findings)
    const claudeText = readTextOrReport(claudeAbs, hostIo, repoRoot, findings)
    if (agyText === undefined || claudeText === undefined) {
      continue
    }
    findings.push(...auditAdapterSkillParityPair(clause, agyText, claudeText))
  }
}
