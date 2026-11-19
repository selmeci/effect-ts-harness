import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  BackupDirPath,
  BackupFileHash,
  WorkflowBackupCount,
  WorkflowBackupFilePath,
  WorkflowBackupMode,
  WorkflowBackupTimestampMs,
  WorkflowStoreFailureReason,
  WorkflowStoreOperation,
  WorkflowStoreUnavailableError,
} from "@harness/contract"
import { WorkflowGraphBackup } from "../src/index.js"

const BACKUP_SHA = BackupFileHash.make("a".repeat(64))

describe("@harness/service workflow ports", () => {
  it.effect("resolves WorkflowGraphBackup exportBackup and restoreBackup from a test layer", () =>
    Effect.gen(function* () {
      const backup = yield* WorkflowGraphBackup
      const exported = yield* backup.exportBackup(
        BackupDirPath.make("/repo/.git/harness/workflow-backups"),
      )
      expect(exported.backupFile).toBe("/repo/.git/harness/workflow-backups/backup-1.ndjson")
      expect(exported.entityCount).toBe(42)
      expect(exported.sha256).toBe(BACKUP_SHA)

      const restored = yield* backup.restoreBackup({
        backupFile: exported.backupFile,
        mode: WorkflowBackupMode.make("merge"),
      })
      expect(restored.mode).toBe("merge")
      expect(restored.restoredEntityCount).toBe(42)
    }).pipe(
      Effect.provideService(WorkflowGraphBackup, {
        exportBackup: (backupDir) =>
          Effect.succeed({
            backupFile: WorkflowBackupFilePath.make(`${backupDir}/backup-1.ndjson`),
            entityCount: WorkflowBackupCount.make(42),
            timestampMs: WorkflowBackupTimestampMs.make(1_700_000_000_000),
            sha256: BACKUP_SHA,
          }),
        restoreBackup: (request) =>
          Effect.succeed({
            backupFile: request.backupFile,
            mode: request.mode,
            restoredEntityCount: WorkflowBackupCount.make(42),
            timestampMs: WorkflowBackupTimestampMs.make(1_700_000_000_001),
            sha256: BACKUP_SHA,
          }),
      }),
    ),
  )

  it.effect("surfaces WorkflowStoreUnavailableError from WorkflowGraphBackup", () =>
    Effect.gen(function* () {
      const backup = yield* WorkflowGraphBackup
      const err = yield* backup
        .exportBackup(BackupDirPath.make("/repo/.git/harness/workflow-backups"))
        .pipe(Effect.flip)
      expect(err._tag).toBe("WorkflowStoreUnavailableError")
      expect(err.operation).toBe("exportBackup")
      expect(err.message).toContain("connection refused")
    }).pipe(
      Effect.provideService(WorkflowGraphBackup, {
        exportBackup: () =>
          Effect.fail(
            new WorkflowStoreUnavailableError({
              operation: WorkflowStoreOperation.make("exportBackup"),
              reason: WorkflowStoreFailureReason.make("connection refused"),
            }),
          ),
        restoreBackup: () =>
          Effect.fail(
            new WorkflowStoreUnavailableError({
              operation: WorkflowStoreOperation.make("restoreBackup"),
              reason: WorkflowStoreFailureReason.make("connection refused"),
            }),
          ),
      }),
    ),
  )
})
