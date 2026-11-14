import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { Effect, Layer, Option, Semaphore, SynchronizedRef } from "effect"
import { match } from "ts-pattern"
import {
  type ActiveMutantId,
  ErrorReasonMessage,
  HarnessSubprocessError,
  type SubprocessExecInput,
  type SubprocessExecResult,
  SubprocessExitCode,
  SubprocessOutput,
  validateSubprocessInput,
  WorkspaceFileContent,
  WorkspaceFsError,
  WorkspaceFsOperation,
} from "@harness/contract"
import {
  ActiveMutantContext,
  HarnessSubprocessRunner,
  type SyncHostIo,
  WorkspaceFs,
} from "@harness/service"
import { getActiveMutantId, setActiveMutantId } from "../../src/services/active-mutant-context.js"

export const makeWorkspaceFsHostIoLayer = (hostIo: SyncHostIo): Layer.Layer<WorkspaceFs> =>
  Layer.succeed(WorkspaceFs, {
    readTextFile: (filePath) =>
      Effect.try({
        try: () => WorkspaceFileContent.make(hostIo.readTextSync(filePath)),
        catch: (err) =>
          new WorkspaceFsError({
            filePath,
            operation: WorkspaceFsOperation.make("read"),
            reason: ErrorReasonMessage.make(
              err instanceof Error && err.message.trim().length > 0 ? err.message : "Read failed",
            ),
          }),
      }),
    writeTextFileAtomic: (filePath, content) =>
      Effect.suspend(() => {
        const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
        return Effect.try({
          try: () => {
            hostIo.mkdirRecursiveSync(dirname(filePath))
            hostIo.writeTextSync(tmpPath, content)
            hostIo.renameSync(tmpPath, filePath)
          },
          catch: (err) =>
            new WorkspaceFsError({
              filePath,
              operation: WorkspaceFsOperation.make("write"),
              reason: ErrorReasonMessage.make(
                err instanceof Error && err.message.trim().length > 0
                  ? err.message
                  : "Write failed",
              ),
            }),
        }).pipe(
          Effect.ensuring(
            Effect.ignore(
              Effect.try({
                try: () => {
                  if (hostIo.existsSync(tmpPath)) {
                    hostIo.unlinkSync(tmpPath)
                  }
                },
                catch: () => undefined,
              }),
            ),
          ),
        )
      }),
    exists: (filePath) => Effect.sync(() => hostIo.existsSync(filePath)),
  })

export const makeWorkspaceFsMemoryLayer = (
  initialFiles: Readonly<Record<string, string>> = {},
): Layer.Layer<WorkspaceFs> =>
  Layer.effect(
    WorkspaceFs,
    Effect.sync(() => {
      const store = new Map<string, string>(Object.entries(initialFiles))
      return {
        readTextFile: (filePath) =>
          Effect.suspend(() => {
            const val = store.get(filePath)
            if (val === undefined) {
              return Effect.fail(
                new WorkspaceFsError({
                  filePath,
                  operation: WorkspaceFsOperation.make("read"),
                  reason: ErrorReasonMessage.make(`File not found in memory layer: ${filePath}`),
                }),
              )
            }
            return Effect.succeed(WorkspaceFileContent.make(val))
          }),
        writeTextFileAtomic: (filePath, content) =>
          Effect.sync(() => {
            store.set(filePath, content)
          }),
        exists: (filePath) => Effect.sync(() => store.has(filePath)),
      }
    }),
  )

export const makeHarnessSubprocessRunnerHostIoLayer = (
  hostIo: SyncHostIo,
): Layer.Layer<HarnessSubprocessRunner> =>
  Layer.succeed(HarnessSubprocessRunner, {
    exec: (input) =>
      Effect.gen(function* () {
        yield* match(validateSubprocessInput(input))
          .with({ _tag: "Some" }, ({ value }) => Effect.fail(value))
          .with({ _tag: "None" }, () => Effect.void)
          .exhaustive()
        const res = yield* Effect.try({
          try: () =>
            hostIo.execFileSync(input.command, input.args, {
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? 60_000,
              maxBufferBytes: input.maxBufferBytes ?? 10 * 1024 * 1024,
            }),
          catch: (err) =>
            new HarnessSubprocessError({
              command: input.command,
              exitCode: SubprocessExitCode.make(1),
              stderr: SubprocessOutput.make(err instanceof Error ? err.message : String(err)),
              reason: ErrorReasonMessage.make(
                `Command '${input.command}' failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
              ),
            }),
        })
        if (res.spawnError !== undefined) {
          return yield* new HarnessSubprocessError({
            command: input.command,
            exitCode: SubprocessExitCode.make(res.exitCode),
            stderr: SubprocessOutput.make(res.stderr),
            reason: ErrorReasonMessage.make(
              `Command '${input.command}' failed to spawn: ${res.spawnError}`,
            ),
          })
        }
        return {
          command: input.command,
          exitCode: SubprocessExitCode.make(res.exitCode),
          stdout: SubprocessOutput.make(res.stdout),
          stderr: SubprocessOutput.make(res.stderr),
        }
      }),
  })

export const makeHarnessSubprocessRunnerTestLayer = (
  handler: (
    input: SubprocessExecInput,
  ) => Effect.Effect<SubprocessExecResult, HarnessSubprocessError>,
): Layer.Layer<HarnessSubprocessRunner> =>
  Layer.succeed(HarnessSubprocessRunner, {
    exec: handler,
  })

export const ActiveMutantContextLive: Layer.Layer<ActiveMutantContext> = Layer.effect(
  ActiveMutantContext,
  Effect.gen(function* () {
    const stateRef = yield* SynchronizedRef.make<Option.Option<ActiveMutantId>>(Option.none())
    const sem = yield* Semaphore.make(1)
    let holdingFiberId: number | undefined = undefined

    return {
      getCurrentMutant: SynchronizedRef.get(stateRef),
      runWithMutant: <A, E, R>(mutantId: ActiveMutantId, effect: Effect.Effect<A, E, R>) =>
        Effect.withFiber((fiber) => {
          const isSameFiber = holdingFiberId !== undefined && holdingFiberId === fiber.id
          const bracket = Effect.acquireUseRelease(
            SynchronizedRef.modify(stateRef, (prev) => {
              const prevGlobal = getActiveMutantId()
              const prevHolder = holdingFiberId
              holdingFiberId = fiber.id
              setActiveMutantId(mutantId)
              return [{ prevRef: prev, prevGlobal, prevHolder }, Option.some(mutantId)] as const
            }),
            () => effect,
            ({ prevRef, prevGlobal, prevHolder }) =>
              SynchronizedRef.set(stateRef, prevRef).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    holdingFiberId = prevHolder
                    setActiveMutantId(prevGlobal)
                  }),
                ),
              ),
          )
          return isSameFiber ? bracket : sem.withPermits(1)(bracket)
        }),
    }
  }),
)
