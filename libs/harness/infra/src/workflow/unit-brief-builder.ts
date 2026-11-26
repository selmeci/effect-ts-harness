import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type AttemptNumber,
  BriefPrompt,
  type CompiledWorkUnit,
  type RunnerConfigFilePath,
  UnitBrief,
  type UnitRejection,
} from "@harness/contract"
import type { TypedHoleContextBundle } from "@harness/graph"

/** Input to deterministic `buildUnitBrief` prompt construction. */
export interface BuildUnitBriefInput {
  readonly unit: CompiledWorkUnit
  readonly attempt: AttemptNumber
  readonly cwd: AbsoluteRepoRoot
  readonly priorRejection?: UnitRejection | undefined
  readonly holeBundles?: ReadonlyArray<TypedHoleContextBundle> | undefined
  readonly mcpConfigPath?: RunnerConfigFilePath | undefined
}

const MAX_HOLE_BUNDLE_TOKENS = 1500
const MAX_BRIEF_PROMPT_CHARS = 65_536

const sanitizeUntrustedText = (raw: string): string => {
  const normalized = raw.replaceAll("\r\n", "\n")
  let out = ""
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i)
    if (code <= 0x1f && code !== 0x0a) {
      out += " "
    } else {
      out += normalized[i]
    }
  }
  return out
}

const formatCommaList = (items: ReadonlyArray<string>): string =>
  items.length > 0 ? items.join(", ") : "(none)"

const formatHoleBundleLine = (bundle: TypedHoleContextBundle): string => {
  const errorsText = formatCommaList(bundle.allowedErrorConstructors)
  const capsText = formatCommaList(bundle.requiredServiceCapabilities)
  const candidates =
    bundle.inhabitingCandidates.length > 0
      ? `; candidates=[${bundle.inhabitingCandidates
          .map((c) => `${c.symbolKey} (${c.inhabitsChannel}, ppr=${c.pprScore})`)
          .join(", ")}]`
      : ""
  return sanitizeUntrustedText(
    `- ${bundle.holeQualname} (span=${bundle.spanName}, tokens=${bundle.estimatedTokens}): success=${bundle.successTypeSignature}; errors=[${errorsText}]; capabilities=[${capsText}]${candidates}`,
  )
}

const selectBoundedHoleBundles = (
  bundles: ReadonlyArray<TypedHoleContextBundle> | undefined,
): ReadonlyArray<string> => {
  if (bundles === undefined || bundles.length === 0) {
    return []
  }
  const lines: Array<string> = []
  let usedTokens = 0
  for (const bundle of bundles) {
    const tokens = Number.isFinite(bundle.estimatedTokens) ? Math.max(0, bundle.estimatedTokens) : 0
    if (usedTokens + tokens <= MAX_HOLE_BUNDLE_TOKENS) {
      lines.push(formatHoleBundleLine(bundle))
      usedTokens += tokens
    }
  }
  return lines
}

const formatPriorRejection = (rejection: UnitRejection): string =>
  sanitizeUntrustedText(
    match(rejection)
      .with(
        { _tag: "WriteSetViolation" },
        (r) =>
          `WriteSetViolation: Modified paths outside ownedRelPaths: ${r.offendingPaths.join(", ")}. Revert or avoid touching non-owned paths.`,
      )
      .with({ _tag: "PackageVerifyFailed" }, (r) => {
        const detail = r.detail !== undefined ? ` (${r.detail})` : ""
        return `PackageVerifyFailed: Command failed (${r.failureKind}, exit ${r.exitCode})${detail}. Fix the failing check and re-run verification.`
      })
      .with(
        { _tag: "StampMissing" },
        () =>
          "StampMissing: Verification stamp was not recorded. Run the required verification command cleanly before finishing.",
      )
      .with(
        { _tag: "AgentFailed" },
        (r) =>
          `AgentFailed: Previous runner attempt failed (${r.reason}). Address the failure and verify owned changes.`,
      )
      .exhaustive(),
  )

interface BoundedSectionSpec {
  readonly prefix: string
  readonly body: string
  readonly suffix: string
}

const fitBoundedSection = (spec: BoundedSectionSpec, maxChars: number): string | undefined => {
  const bodyBudget = maxChars - spec.prefix.length - spec.suffix.length
  if (bodyBudget <= 0) {
    return undefined
  }
  return `${spec.prefix}${spec.body.slice(0, bodyBudget)}${spec.suffix}`
}

const allocateBothSections = (
  holeSpec: BoundedSectionSpec,
  rejectionSpec: BoundedSectionSpec,
  remaining: number,
): ReadonlyArray<string> => {
  const holeFullLen = holeSpec.prefix.length + holeSpec.body.length + holeSpec.suffix.length
  const rejFullLen =
    rejectionSpec.prefix.length + rejectionSpec.body.length + rejectionSpec.suffix.length
  const contentRemaining = Math.max(0, remaining - 4)
  const half = Math.floor(contentRemaining / 2)
  const rejBudget = Math.min(rejFullLen, Math.max(half, contentRemaining - holeFullLen))
  const holeBudget = Math.min(holeFullLen, contentRemaining - rejBudget)
  const fittedHole = fitBoundedSection(holeSpec, holeBudget)
  const fittedRej = fitBoundedSection(rejectionSpec, rejBudget)
  return [
    ...(fittedHole !== undefined ? [fittedHole] : []),
    ...(fittedRej !== undefined ? [fittedRej] : []),
  ]
}

const assembleBriefPromptText = (
  headerText: string,
  workspaceRulesText: string,
  holeSpec: BoundedSectionSpec | undefined,
  rejectionSpec: BoundedSectionSpec | undefined,
): string => {
  const fixedMinChars = headerText.length + 2 + workspaceRulesText.length
  const remaining = MAX_BRIEF_PROMPT_CHARS - fixedMinChars
  if (remaining < 0) {
    const maxHeaderChars = Math.max(0, MAX_BRIEF_PROMPT_CHARS - 2 - workspaceRulesText.length)
    return `${headerText.slice(0, maxHeaderChars).trimEnd()}\n\n${workspaceRulesText}`
  }

  const variableSections: ReadonlyArray<string> = match([
    holeSpec !== undefined,
    rejectionSpec !== undefined,
  ] as const)
    .with([true, true], () =>
      holeSpec !== undefined && rejectionSpec !== undefined
        ? allocateBothSections(holeSpec, rejectionSpec, remaining)
        : [],
    )
    .with([true, false], () => {
      const fitted = holeSpec !== undefined ? fitBoundedSection(holeSpec, remaining - 2) : undefined
      return fitted !== undefined ? [fitted] : []
    })
    .with([false, true], () => {
      const fitted =
        rejectionSpec !== undefined ? fitBoundedSection(rejectionSpec, remaining - 2) : undefined
      return fitted !== undefined ? [fitted] : []
    })
    .with([false, false], () => [])
    .exhaustive()

  return [headerText, ...variableSections, workspaceRulesText].join("\n\n").trim()
}

/** Pure deterministic `UnitBrief` builder embedding `REPO_ROOT`, owned paths, slice/hole context, and retry rejection feedback. */
const buildUnitBrief = (input: BuildUnitBriefInput): UnitBrief => {
  const unitMetadataLines = match(input.unit)
    .with({ _tag: "PackageUnit" }, (pkgUnit) => [
      `UNIT_KIND=PackageUnit`,
      `PROJECT=${pkgUnit.projectName}`,
      `WAVE_INDEX=${pkgUnit.waveIndex}`,
      `PACKAGE_VERIFY_COMMAND=${pkgUnit.packageVerifyCommand}`,
    ])
    .with({ _tag: "SliceUnit" }, (sliceUnit) => [
      `UNIT_KIND=SliceUnit`,
      `SLICE_BRANCH=${sliceUnit.branch}`,
      `WAVE_INDEX=${sliceUnit.waveIndex}`,
    ])
    .exhaustive()

  const ownedPathLines =
    input.unit.ownedRelPaths.length > 0
      ? input.unit.ownedRelPaths.map((p) => `- ${p}`)
      : ["- (none)"]

  const keyLines = match(input.unit)
    .with({ _tag: "PackageUnit" }, (pkgUnit) => [
      `EARS requirements: ${formatCommaList(pkgUnit.earsKeys)}`,
      `Stub symbols: ${formatCommaList(pkgUnit.stubKeys)}`,
    ])
    .with({ _tag: "SliceUnit" }, (sliceUnit) => [
      `EARS requirements: ${formatCommaList(sliceUnit.earsKeys)}`,
    ])
    .exhaustive()

  const verificationInstruction = match(input.unit)
    .with(
      { _tag: "PackageUnit" },
      (pkgUnit) =>
        `Verification: Run \`${pkgUnit.packageVerifyCommand}\` in \`${input.cwd}\` and ensure typecheck, lint, and tests pass.`,
    )
    .with(
      { _tag: "SliceUnit" },
      (sliceUnit) =>
        `Verification: Run \`CI=true pnpm harness verify\` in \`${input.cwd}\` and commit your verified changes to branch \`${sliceUnit.branch}\`.`,
    )
    .exhaustive()

  const holeLines = selectBoundedHoleBundles(input.holeBundles)

  const headerText = [
    `REPO_ROOT=${input.cwd}`,
    `UNIT_ID=${input.unit.unitId}`,
    `ATTEMPT=${input.attempt}`,
    ...unitMetadataLines,
    "",
    "Owned paths (edit ONLY within these paths):",
    ...ownedPathLines,
    "",
    ...keyLines,
    verificationInstruction,
  ].join("\n")

  const holeSpec: BoundedSectionSpec | undefined =
    holeLines.length > 0
      ? {
          prefix: `Typed hole context (bounded <= ${MAX_HOLE_BUNDLE_TOKENS} tokens):\n<typed-hole-context>\n`,
          body: holeLines.join("\n"),
          suffix: "\n</typed-hole-context>",
        }
      : undefined

  const rejectionSpec: BoundedSectionSpec | undefined =
    input.priorRejection !== undefined
      ? {
          prefix: "Prior rejection feedback (address before finishing):\n<prior-rejection>\n- ",
          body: formatPriorRejection(input.priorRejection),
          suffix: "\n</prior-rejection>",
        }
      : undefined

  const workspaceRulesText = [
    "Workspace rules (HARNESS_UNIT_WORKER=1):",
    `- Pass absolute paths rooted at ${input.cwd} to file tools.`,
    "- Do not modify files outside ownedRelPaths, .harness/ state/stamps, or repos/.",
    "- Do not run workflow lifecycle commands (pnpm harness done, workflow start/resume/ship/abort/doctor) or alchemy deploy/destroy.",
  ].join("\n")

  const promptText = assembleBriefPromptText(
    headerText,
    workspaceRulesText,
    holeSpec,
    rejectionSpec,
  )

  return UnitBrief.make({
    unitId: input.unit.unitId,
    attempt: input.attempt,
    promptText: BriefPrompt.make(promptText),
    ownedRelPaths: input.unit.ownedRelPaths,
    ...match(input.unit)
      .with({ _tag: "PackageUnit" }, (pkgUnit) => ({
        packageVerifyCommand: pkgUnit.packageVerifyCommand,
      }))
      .with({ _tag: "SliceUnit" }, () => ({}))
      .exhaustive(),
    ...(input.mcpConfigPath !== undefined ? { mcpConfigPath: input.mcpConfigPath } : {}),
  })
}

export { buildUnitBrief }
