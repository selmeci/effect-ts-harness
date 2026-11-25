import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { Effect, Option, Result } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { checkVerifyStamp } from "@harness/gates"
import {
  type HarnessGraph,
  loadGraphSnapshotEffect,
  readGraphHeadMetaState,
  resolveGitHeadState,
  saveGraphSnapshot,
} from "@harness/graph"
import { isSafeHarnessLeafPathWith } from "@harness/infra/hook-io"
import type { SyncHostIo } from "@harness/service/host-io"
import { isInsideRoot } from "./repo-path.js"
import { resolveHarnessStateDirSafe } from "./session-fastpath.js"

export type PlanSnapshotReuseResult =
  | { readonly _tag: "Hit"; readonly graph: HarnessGraph }
  | { readonly _tag: "Miss"; readonly reason: string }

export type PersistSnapshotResult =
  | { readonly _tag: "Saved" }
  | { readonly _tag: "Failed"; readonly reason: string }

const isSafeRegularSnapshotPath = (
  repoRoot: string,
  harnessDir: string,
  snapshotPath: string,
  hostIo: SyncHostIo,
  requireExistingFile: boolean,
): boolean =>
  isInsideRoot(resolve(harnessDir), resolve(snapshotPath)) &&
  isSafeHarnessLeafPathWith(
    repoRoot,
    harnessDir,
    snapshotPath,
    {
      existsSync: (filePath) => hostIo.existsSync(filePath),
      isFileSync: (filePath) => hostIo.isFileSync(filePath),
      isSymbolicLinkSync: (filePath) => hostIo.isSymbolicLinkSync(filePath),
      realpathSync: (filePath) => hostIo.realpathSync(filePath),
      getEnv: () => ({}),
    },
    requireExistingFile,
  )

const graphHasStubNodes = (graph: HarnessGraph): boolean => {
  for (const [, node] of Graph.nodes(graph.graph)) {
    const isStub = match(node)
      .with({ _tag: "EffectFn" }, (n) => n.isStub)
      .with(
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
        { _tag: "PatternDoc" },
        { _tag: "AdrDoc" },
        { _tag: "EarsSpec" },
        { _tag: "EarsRequirement" },
        { _tag: "EffectSignature" },
        { _tag: "LayerFlow" },
        { _tag: "TraceabilityTuple" },
        { _tag: "HttpEndpointTuple" },
        { _tag: "MigrationTuple" },
        () => false,
      )
      .exhaustive()
    if (isStub) return true
  }
  return false
}

export const persistReusedPlanSnapshotIfSafe = (
  repoRoot: string,
  snapshotPath: string,
  graph: HarnessGraph,
  hostIo: SyncHostIo,
): PersistSnapshotResult => {
  const harnessDir = resolve(repoRoot, ".harness")
  if (!isSafeRegularSnapshotPath(repoRoot, harnessDir, snapshotPath, hostIo, false)) {
    return { _tag: "Failed", reason: `Unsafe snapshot path: ${snapshotPath}` }
  }
  return match(Result.try(() => saveGraphSnapshot(graph, snapshotPath, hostIo)))
    .with({ _tag: "Success" }, () => ({ _tag: "Saved" as const }))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Failed" as const,
      reason: failure instanceof Error ? failure.message : String(failure),
    }))
    .exhaustive()
}

export const tryLoadReusableVerifiedPlanSnapshot = Effect.fnUntraced(function* (
  repoRoot: string,
  hasActiveStubs: boolean,
  hostIo: SyncHostIo,
): Effect.fn.Return<PlanSnapshotReuseResult> {
  if (hasActiveStubs) {
    return { _tag: "Miss", reason: "active-stubs" }
  }
  const defaultHarnessDir = resolve(repoRoot, ".harness")
  const stateDirOpt = resolveHarnessStateDirSafe(repoRoot, hostIo.getEnv())
  const isDefaultStateDir = match(stateDirOpt)
    .with({ _tag: "Some" }, ({ value }) => resolve(value) === defaultHarnessDir)
    .with({ _tag: "None" }, () => false)
    .exhaustive()
  if (!isDefaultStateDir) {
    return { _tag: "Miss", reason: "non-default-state-dir" }
  }
  const stampCheck = checkVerifyStamp(repoRoot, hostIo)
  if (!stampCheck.valid) {
    return { _tag: "Miss", reason: "stamp-invalid" }
  }
  const headState = resolveGitHeadState(repoRoot, hostIo)
  if (headState.headSha === null || headState.headSha.length === 0) {
    return { _tag: "Miss", reason: "head-mismatch" }
  }
  const headMetaPath = join(defaultHarnessDir, "graph-head.json")
  if (!isSafeRegularSnapshotPath(repoRoot, defaultHarnessDir, headMetaPath, hostIo, true)) {
    return { _tag: "Miss", reason: "unsafe-or-missing-head-meta" }
  }
  const headMatches = match(readGraphHeadMetaState(repoRoot, hostIo))
    .with(
      { _tag: "Present" },
      ({ meta }) => meta.headSha === headState.headSha && meta.gitBranch === headState.gitBranch,
    )
    .with({ _tag: "Missing" }, { _tag: "Corrupt" }, () => false)
    .exhaustive()
  if (!headMatches) {
    return { _tag: "Miss", reason: "head-mismatch" }
  }
  const snapshotPath = join(defaultHarnessDir, "graph-snapshot.json")
  if (!isSafeRegularSnapshotPath(repoRoot, defaultHarnessDir, snapshotPath, hostIo, true)) {
    return { _tag: "Miss", reason: "unsafe-or-missing-snapshot" }
  }
  const expectedSha = stampCheck.stamp.graphSnapshotSha256
  if (expectedSha === undefined) {
    return { _tag: "Miss", reason: "missing-snapshot-hash" }
  }
  const hashCheck = match(
    Result.try(() =>
      createHash("sha256").update(hostIo.readTextSync(snapshotPath), "utf8").digest("hex"),
    ),
  )
    .with({ _tag: "Success" }, ({ success: sha }) =>
      sha === expectedSha
        ? ({ _tag: "Ok" } as const)
        : { _tag: "Miss" as const, reason: "snapshot-hash-mismatch" },
    )
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "Miss" as const,
      reason: `unreadable-snapshot: ${failure instanceof Error ? failure.message : String(failure)}`,
    }))
    .exhaustive()
  return yield* match(hashCheck)
    .with({ _tag: "Miss" }, (miss) => Effect.succeed(miss))
    .with({ _tag: "Ok" }, () =>
      loadGraphSnapshotEffect(snapshotPath, hostIo).pipe(
        Effect.asSome,
        Effect.catchTag("GraphSnapshotError", () => Effect.succeed(Option.none<HarnessGraph>())),
        Effect.map((loadedOpt) =>
          match(loadedOpt)
            .with({ _tag: "None" }, () => ({ _tag: "Miss" as const, reason: "corrupt-snapshot" }))
            .with({ _tag: "Some" }, ({ value: graph }) =>
              graphHasStubNodes(graph)
                ? { _tag: "Miss" as const, reason: "snapshot-has-stubs" }
                : { _tag: "Hit" as const, graph },
            )
            .exhaustive(),
        ),
      ),
    )
    .exhaustive()
})
