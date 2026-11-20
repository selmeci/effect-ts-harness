import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Effect } from "effect"
import { runCliEffect, runCliProgram, teardownCliMain } from "./commands/cli-runtime.js"
import {
  CANONICAL_CLI_COMMAND_NAMES,
  CliCommandName,
  CliCommandNotFoundError,
  type CliCommandPluginDescriptor,
  DEFAULT_CLI_COMMAND_DESCRIPTORS,
  dispatchCliCommand,
  HarnessCommandRegistry,
  HarnessCommandRegistryLive,
  lazyImportCliHandler,
  makeHarnessCommandRegistryLayer,
  makeLiveCliCommandRegistryLayer,
} from "./commands/command-registry.js"
import {
  buildOmnigraphClusterKillArgs,
  checkOllamaServerReady,
  cleanSubprocessError,
  type CliEnv,
  type CliResult,
  COMMANDS,
  type Command,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  formatSubprocessError,
  isCommand,
  type OllamaReadinessOptions,
  resolveCommandTelemetryOutcome,
  stripAnsiCodes,
  tryQueryWarmDaemonSocket,
} from "./commands/daemon-and-omnigraph.service.js"
import { harnessRootCommand, runDeclarativeCli } from "./commands/declarative-cli.js"

export const handleIngest = (
  args: ReadonlyArray<string>,
  options?: CliEnv,
): Effect.Effect<CliResult> =>
  lazyImportCliHandler(
    "ingest",
    () => import("./commands/session-learn-report.command.js"),
    (m) => m.handleIngest(args, options),
  )

export {
  buildOmnigraphClusterKillArgs,
  CANONICAL_CLI_COMMAND_NAMES,
  checkOllamaServerReady,
  cleanSubprocessError,
  CliCommandName,
  CliCommandNotFoundError,
  type CliCommandPluginDescriptor,
  type CliEnv,
  type CliResult,
  COMMANDS,
  type Command,
  DEFAULT_CLI_COMMAND_DESCRIPTORS,
  dispatchCliCommand,
  ensureLocalOllamaReady,
  ensureLocalOmnigraphReady,
  formatSubprocessError,
  HarnessCommandRegistry,
  HarnessCommandRegistryLive,
  harnessRootCommand,
  isCommand,
  makeHarnessCommandRegistryLayer,
  makeLiveCliCommandRegistryLayer,
  type OllamaReadinessOptions,
  resolveCommandTelemetryOutcome,
  runCliEffect,
  runDeclarativeCli,
  stripAnsiCodes,
  teardownCliMain,
  tryQueryWarmDaemonSocket,
}

if (
  process.argv[1] !== undefined &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("index.ts"))
) {
  runCliProgram(process.argv.slice(2))
}
