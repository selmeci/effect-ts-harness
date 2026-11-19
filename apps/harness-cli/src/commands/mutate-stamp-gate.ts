import { Result } from "effect"
import { match } from "ts-pattern"
import {
  checkMutateStamp,
  extractGitDiffModifiedLinesChecked,
  findDomainFiles,
  findUnclassifiedModifiedLibFiles,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import type { SyncHostIo } from "@harness/service/host-io"
import type { CliEnv } from "./daemon-and-omnigraph.service.js"
import { isIsolatedExternalWorkspace } from "./repo-path.js"

export type CollectModifiedMutableFilesResult =
  | { readonly _tag: "Clean" }
  | { readonly _tag: "DiffFailed"; readonly reason: string }
  | {
      readonly _tag: "Dirty"
      readonly files: ReadonlyArray<string>
      readonly unclassifiedFiles: ReadonlyArray<string>
    }

export const collectModifiedMutableFiles = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): CollectModifiedMutableFilesResult =>
  match(Result.try(() => findDomainFiles(repoRoot, hostIo)))
    .with({ _tag: "Failure" }, ({ failure }) => ({
      _tag: "DiffFailed" as const,
      reason: failure instanceof Error ? failure.message : String(failure),
    }))
    .with({ _tag: "Success" }, ({ success: domainFiles }) =>
      match(
        extractGitDiffModifiedLinesChecked(repoRoot, hostIo, {
          fallbackBaseRef: "main",
        }),
      )
        .with({ _tag: "Failed" }, ({ reason }) => ({ _tag: "DiffFailed" as const, reason }))
        .with({ _tag: "NotGit" }, () =>
          domainFiles.length > 0
            ? {
                _tag: "Dirty" as const,
                files: domainFiles.map((f) => f.relFile),
                unclassifiedFiles: [],
              }
            : { _tag: "Clean" as const },
        )
        .with({ _tag: "Ok" }, ({ lines }) =>
          match(
            Result.try(() =>
              findUnclassifiedModifiedLibFiles(repoRoot, lines, domainFiles, hostIo),
            ),
          )
            .with({ _tag: "Failure" }, ({ failure }) => ({
              _tag: "DiffFailed" as const,
              reason: failure instanceof Error ? failure.message : String(failure),
            }))
            .with({ _tag: "Success" }, ({ success: unclassifiedFiles }) => {
              const dirtyMutableFiles = domainFiles
                .filter((f) => lines.has(f.relFile))
                .map((f) => f.relFile)
              return dirtyMutableFiles.length > 0 || unclassifiedFiles.length > 0
                ? {
                    _tag: "Dirty" as const,
                    files: dirtyMutableFiles,
                    unclassifiedFiles,
                  }
                : { _tag: "Clean" as const }
            })
            .exhaustive(),
        )
        .exhaustive(),
    )
    .exhaustive()

export const hasModifiedMutableFiles = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): boolean =>
  match(collectModifiedMutableFiles(repoRoot, hostIo))
    .with({ _tag: "Clean" }, () => false)
    .with({ _tag: "DiffFailed" }, { _tag: "Dirty" }, () => true)
    .exhaustive()

export const isVerifyMutateStampGateEnforced = (
  repoRoot: string,
  options: CliEnv | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
): boolean =>
  match(options?.mutateStampPolicy)
    .with("skip", () => false)
    .with("enforce", () => true)
    .with(
      undefined,
      () =>
        options?.skipSubprocessVerify !== true && !isIsolatedExternalWorkspace(repoRoot, hostIo),
    )
    .exhaustive()

export const evaluateVerifyMutateStampGate = (
  repoRoot: string,
  options: CliEnv | undefined,
  hostIo: SyncHostIo = nodeSyncHostIo,
): string | undefined => {
  if (!isVerifyMutateStampGateEnforced(repoRoot, options, hostIo)) {
    return undefined
  }
  return match(collectModifiedMutableFiles(repoRoot, hostIo))
    .with({ _tag: "Clean" }, () => undefined)
    .with({ _tag: "DiffFailed" }, ({ reason }) => reason)
    .with({ _tag: "Dirty" }, ({ files, unclassifiedFiles }) =>
      unclassifiedFiles.length > 0
        ? `Unclassified modified lib file(s) cannot bypass mutation coverage: ${unclassifiedFiles.join(", ")}.`
        : match(checkMutateStamp(repoRoot, hostIo, files))
            .with({ _tag: "Valid" }, () => undefined)
            .with({ _tag: "Invalid" }, ({ reason }) => reason)
            .exhaustive(),
    )
    .exhaustive()
}

export const resolveVerifyStampMutateMeta = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
) =>
  match(checkMutateStamp(repoRoot, hostIo))
    .with({ _tag: "Valid" }, ({ stamp }) => ({
      mutateEnforcementMode: stamp.enforcementMode,
      mutantsEvaluated: stamp.totalMutants,
    }))
    .with({ _tag: "Invalid" }, () => undefined)
    .exhaustive()
