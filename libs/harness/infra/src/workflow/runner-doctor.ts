import { delimiter, join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  WorkflowDoctorCheckItem,
  WorkflowDoctorCheckName,
  toBoundedReason,
} from "@harness/contract"
import type { ExtendedHostIo } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"

/** Inputs for read-only runner readiness inspection in `workflow doctor`. */
export interface WorkflowRunnerDoctorOptions {
  readonly runnerKind: "live" | "placeholder"
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly hostIo?: ExtendedHostIo | undefined
}

const AntigravitySettingsJsonSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
)
const decodeAntigravitySettingsResult = Schema.decodeUnknownResult(AntigravitySettingsJsonSchema)

const findExecutableOnPath = (
  binary: string,
  pathEnv: string | undefined,
  hostIo: ExtendedHostIo,
): string | undefined => {
  if (pathEnv === undefined || pathEnv.trim().length === 0) {
    return undefined
  }
  const dirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0)
  for (const dir of dirs) {
    const candidate = join(dir, binary)
    if (!hostIo.isFileSync(candidate)) {
      continue
    }
    if (process.platform === "win32") {
      return candidate
    }
    const mode = hostIo.statModeSync(candidate)
    if (mode !== undefined && (mode & 0o111) !== 0) {
      return candidate
    }
  }
  return undefined
}

interface AntigravitySettingsInspection {
  readonly valid: boolean
  readonly detail: string
}

const inspectAntigravitySettings = (
  homeDir: string | undefined,
  hostIo: ExtendedHostIo,
): AntigravitySettingsInspection => {
  const trimmedHome = homeDir?.trim()
  if (trimmedHome === undefined || trimmedHome.length === 0) {
    return {
      valid: false,
      detail: "HOME is unset; cannot inspect Antigravity settings.json",
    }
  }
  const settingsPath = join(trimmedHome, ".gemini", "antigravity-cli", "settings.json")
  if (hostIo.isSymbolicLinkSync(settingsPath)) {
    return {
      valid: false,
      detail: `Refusing symlink Antigravity settings file '${settingsPath}'`,
    }
  }
  if (!hostIo.isFileSync(settingsPath)) {
    return {
      valid: false,
      detail: `Antigravity settings file '${settingsPath}' not found`,
    }
  }
  const readRes = Result.try({
    try: () => hostIo.readTextSync(settingsPath),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return match(readRes)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      valid: false,
      detail: `Failed to read Antigravity settings '${settingsPath}': ${failure}`,
    }))
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(decodeAntigravitySettingsResult(raw))
        .with({ _tag: "Failure" }, () => ({
          valid: false,
          detail: `Antigravity settings '${settingsPath}' contains invalid JSON`,
        }))
        .with({ _tag: "Success" }, () => ({
          valid: true,
          detail: `settings verified at '${settingsPath}'`,
        }))
        .exhaustive(),
    )
    .exhaustive()
}

/** Inspects `claude` / `agy` CLI availability, Antigravity settings readiness, and dispatcher mode. */
const inspectWorkflowRunnerDoctorChecks = (
  options: WorkflowRunnerDoctorOptions,
): Effect.Effect<ReadonlyArray<WorkflowDoctorCheckItem>> =>
  Effect.sync(() => {
    const io = options.hostIo ?? nodeSyncHostIo
    const env = options.env ?? io.getEnv()
    const pathEnv = env["PATH"]

    const dispatcherCheck = match(options.runnerKind)
      .with("live", () =>
        WorkflowDoctorCheckItem.make({
          name: WorkflowDoctorCheckName.make("agent-dispatcher"),
          status: "ok",
          detail: toBoundedReason(
            "Live UnitAgentDispatcher wired to AgentRunnerPort (claude-code, antigravity)",
          ),
        }),
      )
      .with("placeholder", () =>
        WorkflowDoctorCheckItem.make({
          name: WorkflowDoctorCheckName.make("agent-dispatcher"),
          status: "warn",
          detail: toBoundedReason(
            "Placeholder UnitAgentDispatcher is active; Automatic workflow mode is disabled",
          ),
        }),
      )
      .exhaustive()

    const claudePath = findExecutableOnPath("claude", pathEnv, io)
    const claudeCheck = WorkflowDoctorCheckItem.make({
      name: WorkflowDoctorCheckName.make("runner-claude-code"),
      status: claudePath !== undefined ? "ok" : "warn",
      detail: toBoundedReason(
        claudePath !== undefined
          ? `Found executable 'claude' at '${claudePath}'`
          : "Executable 'claude' not found on PATH",
      ),
    })

    const agyPath = findExecutableOnPath("agy", pathEnv, io)
    const settingsInspection = inspectAntigravitySettings(env["HOME"], io)
    const agyReady = agyPath !== undefined && settingsInspection.valid
    const agyDetail =
      agyPath !== undefined
        ? `Found executable 'agy' at '${agyPath}'; ${settingsInspection.detail}`
        : `Executable 'agy' not found on PATH; ${settingsInspection.detail}`
    const agyCheck = WorkflowDoctorCheckItem.make({
      name: WorkflowDoctorCheckName.make("runner-antigravity"),
      status: agyReady ? "ok" : "warn",
      detail: toBoundedReason(agyDetail),
    })

    return [dispatcherCheck, claudeCheck, agyCheck]
  })

export { inspectWorkflowRunnerDoctorChecks }
