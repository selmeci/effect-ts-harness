import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { match } from "ts-pattern"
import { SqlClient } from "effect/sql/SqlClient"
import * as SqliteClientModule from "@effect/sql-sqlite-do/SqliteClient"
import { Workerd, WorkerdLive } from "@alchemy.run/cloudflare-runtime/core/workerd/Workerd"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads"
import type {
  DurableObjectStorage,
  DurableObjectTransaction,
  SqlStorage,
  SqlStorageCursor,
  SqlStorageValue,
} from "@cloudflare/workers-types"
import { BRIDGE_WORKER_SCRIPT, DO_WORKER_ES_MODULE } from "./workerd-scripts.js"

const unsafeCast = <T>(value: unknown): T => value as T

interface SerializedBuffer {
  readonly __ab: ReadonlyArray<number>
}

const isSerializedBuffer = (value: unknown): value is SerializedBuffer =>
  typeof value === "object" &&
  value !== null &&
  "__ab" in value &&
  Array.isArray((value as SerializedBuffer).__ab)

const deserializeSqlValue = (value: unknown): SqlStorageValue => {
  if (isSerializedBuffer(value)) {
    return new Uint8Array(value.__ab).buffer
  }
  return value as SqlStorageValue
}

const serializeSqlBinding = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer) {
    return { __uint8: Array.from(new Uint8Array(value)) }
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __uint8: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    }
  }
  return value
}

class WorkerdSqlCursor<T extends Record<string, SqlStorageValue>> {
  private idx = 0
  readonly rowsRead: number
  readonly rowsWritten: number
  readonly columnNames: Array<string>
  private readonly rawRows: ReadonlyArray<ReadonlyArray<SqlStorageValue>>
  private readonly objectRows: ReadonlyArray<T>

  constructor(
    columnNames: Array<string>,
    rawRows: ReadonlyArray<ReadonlyArray<SqlStorageValue>>,
    rowsRead: number,
    rowsWritten: number,
  ) {
    this.columnNames = columnNames
    this.rawRows = rawRows
    this.rowsRead = rowsRead
    this.rowsWritten = rowsWritten
    this.objectRows = rawRows.map((row) => {
      const obj: Record<string, SqlStorageValue> = {}
      for (let i = 0; i < columnNames.length; i++) {
        const col = columnNames[i]
        const val = row[i]
        if (col !== undefined) {
          obj[col] = val ?? null
        }
      }
      return unsafeCast<T>(obj)
    })
  }

  next(): IteratorResult<T, undefined> {
    if (this.idx < this.objectRows.length) {
      const value = this.objectRows[this.idx++]
      if (value !== undefined) {
        return { done: false, value }
      }
    }
    return { done: true, value: undefined }
  }

  toArray(): Array<T> {
    return [...this.objectRows]
  }

  one(): T {
    const first = this.objectRows[0]
    if (this.objectRows.length === 1 && first !== undefined) {
      return first
    }
    return Effect.runSync(
      Effect.die(
        new Error(
          `Expected exactly 1 row in SqlStorageCursor.one(), got ${this.objectRows.length}`,
        ),
      ),
    )
  }

  *raw<U extends Array<SqlStorageValue>>(): IterableIterator<U> {
    for (const row of this.rawRows) {
      yield unsafeCast<U>([...row])
    }
  }

  *[Symbol.iterator](): IterableIterator<T> {
    yield* this.objectRows
  }
}

class WorkerdSqlStatement {}

interface BridgeExecResult {
  readonly ok: boolean
  readonly message?: string
  readonly columnNames?: Array<string>
  readonly rawRows?: ReadonlyArray<ReadonlyArray<unknown>>
  readonly rowsRead?: number
  readonly rowsWritten?: number
}

interface SharedWorkerdBridge {
  readonly worker: Worker
  readonly scope: Scope.Closeable
  readonly tmpDir: string
  readonly callSync: (payload: Record<string, unknown>) => BridgeExecResult
}

let activeBridge: SharedWorkerdBridge | null = null
let pendingBridgeDeferred: Deferred.Deferred<SharedWorkerdBridge> | null = null
let activeRefCount = 0
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null

const cleanupBridgeResources = (
  scope: Scope.Closeable,
  worker: Worker | undefined,
  tmpDir: string,
): Effect.Effect<void> =>
  Scope.close(scope, Exit.void).pipe(
    Effect.ignoreCause,
    Effect.andThen(
      worker !== undefined
        ? Effect.tryPromise({
            try: () => worker.terminate().then(() => undefined),
            catch: () => undefined,
          }).pipe(Effect.ignoreCause)
        : Effect.void,
    ),
    Effect.andThen(
      Effect.sync(() => {
        rmSync(tmpDir, { recursive: true, force: true })
      }).pipe(Effect.ignoreCause),
    ),
  )

const closeSharedBridge = (bridgeToClose: SharedWorkerdBridge): void => {
  void Effect.runPromise(
    cleanupBridgeResources(bridgeToClose.scope, bridgeToClose.worker, bridgeToClose.tmpDir),
  )
}

const BRIDGE_CALL_TIMEOUT_MS = 30_000

const initSharedWorkerdBridge = (): Effect.Effect<SharedWorkerdBridge> =>
  Effect.gen(function* () {
    const tmpDir = mkdtempSync(join(tmpdir(), "harness-es-workerd-"))
    const bridgeScope = yield* Scope.make()

      let spawnedWorker: Worker | undefined
      const { callbackPort, worker } = yield* Effect.callback<{
        readonly callbackPort: number
        readonly worker: Worker
      }>((resume) => {
        const w = new Worker(BRIDGE_WORKER_SCRIPT, { eval: true })
        spawnedWorker = w
        let settled = false
        w.once("message", (msg: { readonly callbackPort: number }) => {
          if (!settled) {
            settled = true
            resume(Effect.succeed({ callbackPort: msg.callbackPort, worker: w }))
          }
        })
        w.on("error", (err) => {
          if (!settled) {
            settled = true
            resume(Effect.die(err))
          } else {
            process.stderr.write(
              `[es-infra:workerd] Late bridge worker error: ${err instanceof Error ? err.message : String(err)}\n`,
            )
          }
        })
        w.once("exit", (code) => {
          if (!settled) {
            settled = true
            resume(
              Effect.die(
                new Error(
                  `Workerd bridge worker exited prematurely with code ${code} before initialization`,
                ),
              ),
            )
          }
        })
      }).pipe(
        Effect.onError(() => cleanupBridgeResources(bridgeScope, spawnedWorker, tmpDir)),
      )

      const workerd = yield* Workerd.pipe(Effect.provide(WorkerdLive))

      const ports = yield* workerd
        .serve({
          sockets: [
            {
              name: "main",
              address: "127.0.0.1:0",
              http: {},
              service: { name: "main" },
            },
          ],
          services: [
            {
              name: "storage",
              disk: { path: tmpDir, writable: true },
            },
            {
              name: "callback",
              external: {
                address: `127.0.0.1:${String(callbackPort)}`,
                http: {},
              },
            },
            {
              name: "main",
              worker: {
                compatibilityDate: workerd.compatibilityDate,
                modules: [
                  {
                    name: "worker.js",
                    esModule: DO_WORKER_ES_MODULE,
                  },
                ],
                durableObjectNamespaces: [
                  {
                    className: "HarnessSqlDurableObject",
                    uniqueKey: "harness-es-sql-do",
                    enableSql: true,
                  },
                ],
                durableObjectStorage: { localDisk: "storage" },
                bindings: [
                  {
                    name: "DO",
                    durableObjectNamespace: {
                      className: "HarnessSqlDurableObject",
                    },
                  },
                  {
                    name: "CALLBACK",
                    service: { name: "callback" },
                  },
                ],
              },
            },
          ],
        })
        .pipe(
          Scope.provide(bridgeScope),
          Effect.onError(() => cleanupBridgeResources(bridgeScope, worker, tmpDir)),
          Effect.orDie,
        )

      const callSync = (payload: Record<string, unknown>): BridgeExecResult => {
        const sab = new SharedArrayBuffer(4)
        const i32 = new Int32Array(sab)
        const { port1, port2 } = new MessageChannel()
        worker.postMessage({ ...payload, sab, port: port2 }, [port2])
        const waitResult = Atomics.wait(i32, 0, 0, BRIDGE_CALL_TIMEOUT_MS)
        if (waitResult === "timed-out") {
          port1.close()
          return {
            ok: false,
            message: `Workerd SQLite bridge timed out after ${BRIDGE_CALL_TIMEOUT_MS}ms`,
          }
        }
        const received = receiveMessageOnPort(port1)
        port1.close()
        if (received === undefined) {
          return { ok: false, message: "No response received from workerd bridge" }
        }
        return received.message as BridgeExecResult
      }

      const initRes = callSync({ type: "set-workerd-port", workerdPort: ports.main })
      if (!initRes.ok) {
        yield* cleanupBridgeResources(bridgeScope, worker, tmpDir)
        return yield* Effect.die(
          new Error(initRes.message ?? "Failed to initialize workerd SQLite bridge port"),
        )
      }

      const bridge: SharedWorkerdBridge = {
        worker,
        scope: bridgeScope,
        tmpDir,
        callSync,
      }
      activeBridge = bridge
      return bridge
    })

const acquireSharedWorkerdBridge = (): Effect.Effect<SharedWorkerdBridge, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      if (idleCloseTimer !== null) {
        clearTimeout(idleCloseTimer)
        idleCloseTimer = null
      }
      if (activeBridge !== null) {
        activeRefCount += 1
        return activeBridge
      }
      if (pendingBridgeDeferred !== null) {
        activeRefCount += 1
        return yield* Deferred.await(pendingBridgeDeferred).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              activeRefCount = Math.max(0, activeRefCount - 1)
            }),
          ),
        )
      }
      const deferred = yield* Deferred.make<SharedWorkerdBridge>()
      pendingBridgeDeferred = deferred
      activeRefCount += 1
      return yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(initSharedWorkerdBridge())
        return yield* match(exit)
          .with({ _tag: "Success" }, ({ value }) =>
            Deferred.succeed(deferred, value).pipe(Effect.as(value)),
          )
          .with({ _tag: "Failure" }, ({ cause }) =>
            Deferred.failCause(deferred, cause).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  activeRefCount = Math.max(0, activeRefCount - 1)
                }),
              ),
              Effect.andThen(Effect.failCause(cause)),
            ),
          )
          .exhaustive()
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pendingBridgeDeferred = null
          }),
        ),
      )
    }),
    () =>
      Effect.sync(() => {
        activeRefCount = Math.max(0, activeRefCount - 1)
        if (activeRefCount === 0 && activeBridge !== null) {
          const bridgeToClose = activeBridge
          idleCloseTimer = setTimeout(() => {
            if (activeRefCount === 0 && activeBridge === bridgeToClose) {
              activeBridge = null
              idleCloseTimer = null
              closeSharedBridge(bridgeToClose)
            }
          }, 50)
        }
      }),
  )

const createWorkerdDurableObjectStorage = (
  bridge: SharedWorkerdBridge,
  doName: string,
): DurableObjectStorage => {
  const txStack: Array<{ readonly txId: string; rolledBack: boolean }> = []
  let txCounter = 0

  const sql: SqlStorage = {
    databaseSize: 0,
    Cursor: unsafeCast<SqlStorage["Cursor"]>(WorkerdSqlCursor),
    Statement: unsafeCast<SqlStorage["Statement"]>(WorkerdSqlStatement),
    exec<T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: ReadonlyArray<unknown>
    ): SqlStorageCursor<T> {
      const currentTx = txStack[txStack.length - 1]
      if (currentTx?.rolledBack) {
        // Note: libs/es/infra/src/memory.ts carries a narrow `unscoped-effect-run` exemption
        // because it bridges synchronous `@cloudflare/workers-types` `SqlStorage.exec` callbacks
        // to the Effect/workerd runtime.
        return Effect.runSync(Effect.die(new Error("Transaction already rolled back")))
      }
      const res = bridge.callSync({
        type: "exec",
        doName,
        txId: currentTx?.txId ?? null,
        query,
        bindings: bindings.map(serializeSqlBinding),
      })
      if (!res.ok) {
        return Effect.runSync(
          Effect.die(new Error(res.message ?? "SQLite execution failed in workerd")),
        )
      }
      const colNames = res.columnNames ?? []
      const rawRows = (res.rawRows ?? []).map((row) => row.map(deserializeSqlValue))
      return unsafeCast<SqlStorageCursor<T>>(
        new WorkerdSqlCursor<T>(
          colNames,
          rawRows,
          res.rowsRead ?? rawRows.length,
          res.rowsWritten ?? 0,
        ),
      )
    },
  }

  const doStorage = {
    sql,
    transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
      const parentTx = txStack[txStack.length - 1]
      txCounter += 1
      const txId = `${doName}-tx-${String(txCounter)}`
      const txEntry = { txId, rolledBack: false }

      const startRes = bridge.callSync({
        type: "begin-tx",
        doName,
        txId,
        parentTxId: parentTx?.txId ?? null,
      })
      if (!startRes.ok) {
        return Promise.reject(
          new Error(startRes.message ?? "Failed to begin workerd DO transaction"),
        )
      }

      txStack.push(txEntry)

      const removeFromTxStack = (): void => {
        const idx = txStack.indexOf(txEntry)
        if (idx !== -1) {
          txStack.splice(idx, 1)
        }
      }

      const safeRollback = (): void => {
        removeFromTxStack()
        if (!txEntry.rolledBack) {
          txEntry.rolledBack = true
          bridge.callSync({
            type: "rollback-tx",
            doName,
            txId,
          })
        }
      }

      const txn = {
        rollback() {
          safeRollback()
        },
      }

      return Promise.resolve()
        .then(() => closure(unsafeCast<DurableObjectTransaction>(txn)))
        .then(
          (result) => {
            removeFromTxStack()
            if (!txEntry.rolledBack) {
              const commitRes = bridge.callSync({
                type: "commit-tx",
                doName,
                txId,
              })
              if (!commitRes.ok) {
                return Promise.reject(
                  new Error(commitRes.message ?? "Failed to commit workerd DO transaction"),
                )
              }
            }
            return result
          },
          (err: unknown) => {
            removeFromTxStack()
            safeRollback()
            return Promise.reject(err)
          },
        )
    },
  }

  return unsafeCast<DurableObjectStorage>(doStorage)
}

export const SqlClientMemoryLayer: Layer.Layer<SqlClient> = Layer.effect(
  SqlClient,
  Effect.gen(function* () {
    const bridge = yield* acquireSharedWorkerdBridge()
    const doName = crypto.randomUUID()
    const storage = createWorkerdDurableObjectStorage(bridge, doName)
    const services = yield* Layer.build(SqliteClientModule.layer({ storage }))
    return Context.get(services, SqlClient)
  }),
)
