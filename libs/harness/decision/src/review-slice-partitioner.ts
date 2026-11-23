import { Schema } from "effect"
import { match } from "ts-pattern"
import {
  type ActiveReviewPlan,
  REVIEW_SLICE_FILE_THRESHOLD,
  type ReviewDiffSignals,
  ReviewRoutingReason,
  type ReviewSignalPath,
  type ReviewSliceFileCount,
  ReviewSliceId,
  ReviewSlicePlan,
  type ReviewerSelection,
  compareCodeUnits,
} from "@harness/contract"

const NON_SLICE_ID_CHAR_RE = /[^a-z0-9._:/-]/g
const MAX_SLICE_ID_BASE_LEN = 112
const SLICE_DIGEST_LEN = 9

const fnv1a32Hex = (raw: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

const toSafeSliceIdBase = (raw: string): string => {
  const lower = raw.toLowerCase()
  const cleaned = lower.replaceAll(NON_SLICE_ID_CHAR_RE, "-").replace(/^-+/, "")
  const candidate =
    cleaned.length === 0 ? "root" : /^[a-z0-9]/.test(cleaned) ? cleaned : `s-${cleaned}`
  const normalized = candidate.slice(0, MAX_SLICE_ID_BASE_LEN)
  if (normalized === lower) {
    return normalized
  }
  const prefix = normalized.slice(0, MAX_SLICE_ID_BASE_LEN - SLICE_DIGEST_LEN)
  return `${prefix}-${fnv1a32Hex(raw)}`
}

const decodeReviewSliceId = Schema.decodeUnknownOption(ReviewSliceId)
const decodeReviewRoutingReason = Schema.decodeUnknownOption(ReviewRoutingReason)

const toSafeSliceId = (sliceKey: string): ReviewSliceId =>
  match(decodeReviewSliceId(sliceKey))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => ReviewSliceId.make(`s-${fnv1a32Hex(sliceKey)}`))
    .exhaustive()

const toSafeSliceLabel = (label: string, unitKey: string): ReviewRoutingReason =>
  match(decodeReviewRoutingReason(label.trim()))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => ReviewRoutingReason.make(`slice-${fnv1a32Hex(unitKey)}`))
    .exhaustive()

/** Resolves a deterministic Nx package or top-level directory unit key for a relative path. */
export const resolveReviewSliceUnitKey = (filePath: ReviewSignalPath): string => {
  const segments = filePath.split("/")
  if (segments.length <= 1) {
    return "root"
  }
  const top = segments[0]!
  if (top === "libs" && segments.length >= 4) {
    return toSafeSliceIdBase(`${segments[0]!}/${segments[1]!}/${segments[2]!}`)
  }
  if ((top === "apps" || top === "adapters" || top === "tools") && segments.length >= 3) {
    return toSafeSliceIdBase(`${segments[0]!}/${segments[1]!}`)
  }
  return toSafeSliceIdBase(top)
}

const toSliceChunk = (
  unitKey: string,
  label: string,
  files: ReadonlyArray<ReviewSignalPath>,
  routeSliceSelections: (
    sliceFiles: readonly [ReviewSignalPath, ...Array<ReviewSignalPath>],
  ) => readonly [ReviewerSelection, ...Array<ReviewerSelection>],
): ReviewSlicePlan => {
  const nonEmptyFiles: readonly [ReviewSignalPath, ...Array<ReviewSignalPath>] = [
    files[0]!,
    ...files.slice(1),
  ]
  return ReviewSlicePlan.make({
    sliceId: toSafeSliceId(unitKey),
    label: toSafeSliceLabel(label, unitKey),
    files: nonEmptyFiles,
    selections: routeSliceSelections(nonEmptyFiles),
  })
}

/**
 * Deterministically partitions large diffs (`>= threshold` changed files) into disjoint, sorted
 * `ReviewSlicePlan` units grouped by Nx package root.
 */
export const partitionDiffReviewSlices = (
  signals: ReviewDiffSignals,
  _wholePlan: ActiveReviewPlan,
  routeSliceSelections: (
    sliceFiles: readonly [ReviewSignalPath, ...Array<ReviewSignalPath>],
  ) => readonly [ReviewerSelection, ...Array<ReviewerSelection>],
  threshold: ReviewSliceFileCount = REVIEW_SLICE_FILE_THRESHOLD,
): readonly [ReviewSlicePlan, ...Array<ReviewSlicePlan>] | undefined => {
  if (signals.changedFiles.length < threshold) {
    return undefined
  }

  const grouped = new Map<string, Array<ReviewSignalPath>>()
  for (const filePath of signals.changedFiles) {
    const unitKey = resolveReviewSliceUnitKey(filePath)
    const bucket = grouped.get(unitKey)
    if (bucket !== undefined) {
      bucket.push(filePath)
    } else {
      grouped.set(unitKey, [filePath])
    }
  }

  const sortedUnits = [...grouped.keys()].sort(compareCodeUnits)
  const slices: Array<ReviewSlicePlan> = []

  for (const unitKey of sortedUnits) {
    const unitFiles = [...grouped.get(unitKey)!].sort(compareCodeUnits)
    if (unitFiles.length <= threshold) {
      slices.push(
        toSliceChunk(
          unitKey,
          `${unitKey} (${unitFiles.length} files)`,
          unitFiles,
          routeSliceSelections,
        ),
      )
      continue
    }

    const totalChunks = Math.ceil(unitFiles.length / threshold)
    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * threshold
      const chunkFiles = unitFiles.slice(start, start + threshold)
      slices.push(
        toSliceChunk(
          `${unitKey}#${idx + 1}`,
          `${unitKey} part ${idx + 1}/${totalChunks} (${chunkFiles.length} files)`,
          chunkFiles,
          routeSliceSelections,
        ),
      )
    }
  }

  return [slices[0]!, ...slices.slice(1)]
}
