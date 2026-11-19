import { Context, type Effect } from "effect"
import type {
  BackupDirPath,
  WorkflowBackupSummary,
  WorkflowRestoreRequest,
  WorkflowRestoreSummary,
  WorkflowStoreUnavailableError,
  WorkspaceFsError,
} from "@harness/contract"

export interface WorkflowGraphBackupShape {
  readonly exportBackup: (
    backupDir: BackupDirPath,
  ) => Effect.Effect<WorkflowBackupSummary, WorkflowStoreUnavailableError | WorkspaceFsError>
  readonly restoreBackup: (
    request: WorkflowRestoreRequest,
  ) => Effect.Effect<WorkflowRestoreSummary, WorkflowStoreUnavailableError | WorkspaceFsError>
}

export class WorkflowGraphBackup extends Context.Service<
  WorkflowGraphBackup,
  WorkflowGraphBackupShape
>()("@harness/service/WorkflowGraphBackup") {}
