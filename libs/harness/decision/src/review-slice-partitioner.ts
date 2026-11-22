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

const toSafeSliceIdBase = (raw: string): string => {
  const sanitized = raw
    .toLowerCase()
    .replaceAll(NON_SLICE_ID_CHAR_RE, "-")
    .replace(/^-+/, "")
    .slice(0, 112)
  return sanitized.length > 0 ? sanitized : "root"
}

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
    sliceId: ReviewSliceId.make(unitKey),
    label: ReviewRoutingReason.make(label),
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
