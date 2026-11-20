import * as Option from "effect/Option"
import { findWorkspaceRootLite, isIngestSnapshotUpToDateLite } from "@harness/infra/hook-io"
import type { CliEnv, CliResult } from "./daemon-and-omnigraph.service.js"
import { hasAntigravityFormat } from "./hook-format.js"

export const tryFastPathIngest = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Option.Option<CliResult> => {
  if (
    !hasAntigravityFormat(argv) ||
    options?.decisionLayer !== undefined ||
    options?.planGraph !== undefined ||
    options?.implGraph !== undefined
  ) {
    return Option.none()
  }
  const repoRoot = options?.repoRoot ?? findWorkspaceRootLite()
  if (!isIngestSnapshotUpToDateLite(repoRoot, process.env)) {
    return Option.none()
  }
  return Option.some({
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    telemetryDetail: "cache=hit",
  })
}
