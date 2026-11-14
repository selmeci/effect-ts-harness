import { Context, type Effect, type Option } from "effect"
import type {
  ActiveMutantId,
  HarnessSubprocessError,
  SubprocessExecInput,
  SubprocessExecResult,
  WorkspaceFileContent,
  WorkspaceFilePath,
  WorkspaceFsError,
} from "@harness/contract"

export interface WorkspaceFsShape {
  readonly readTextFile: (
    filePath: WorkspaceFilePath,
  ) => Effect.Effect<WorkspaceFileContent, WorkspaceFsError>
  readonly writeTextFileAtomic: (
    filePath: WorkspaceFilePath,
    content: WorkspaceFileContent,
  ) => Effect.Effect<void, WorkspaceFsError>
  readonly exists: (filePath: WorkspaceFilePath) => Effect.Effect<boolean, never>
}

export class WorkspaceFs extends Context.Service<WorkspaceFs, WorkspaceFsShape>()(
  "@harness/gates/WorkspaceFs",
) {}

export interface HarnessSubprocessRunnerShape {
  readonly exec: (
    input: SubprocessExecInput,
  ) => Effect.Effect<SubprocessExecResult, HarnessSubprocessError>
}

export class HarnessSubprocessRunner extends Context.Service<
  HarnessSubprocessRunner,
  HarnessSubprocessRunnerShape
>()("@harness/gates/HarnessSubprocessRunner") {}

export interface ActiveMutantContextShape {
  readonly getCurrentMutant: Effect.Effect<Option.Option<ActiveMutantId>>
  readonly runWithMutant: <A, E, R>(
    mutantId: ActiveMutantId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class ActiveMutantContext extends Context.Service<
  ActiveMutantContext,
  ActiveMutantContextShape
>()("@harness/gates/ActiveMutantContext") {}

export {
  AstGateCachePort,
  type AstGateCachePortShape,
  DecisionCachePort,
  type DecisionCachePortShape,
  UnixSocketDaemonPort,
  type UnixSocketDaemonPortShape,
} from "./cache-and-daemon-ports.js"

export type {
  ExtendedHostIo,
  SyncHostDirEntry,
  SyncHostExecOptions,
  SyncHostExecResult,
  SyncHostIo,
} from "./host-io.js"
