import { Context, Effect, Exit, Layer, Scope } from "effect"
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

const DO_WORKER_ES_MODULE = `
import { DurableObject } from "cloudflare:workers";

export class HarnessSqlDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  #execSql(query, bindings) {
    const realBindings = bindings.map((b) =>
      b !== null && typeof b === "object" && Array.isArray(b.__uint8)
        ? new Uint8Array(b.__uint8).buffer
        : b
    );
    const cursor = this.ctx.storage.sql.exec(query, ...realBindings);
    const rawRows = Array.from(cursor.raw()).map((row) =>
      row.map((val) =>
        val instanceof ArrayBuffer ? { __ab: Array.from(new Uint8Array(val)) } : val
      )
    );
    return {
      ok: true,
      columnNames: cursor.columnNames,
      rawRows,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten
    };
  }

  async #runTransactionLoop(txId, txn) {
    while (true) {
      const stepRes = await this.env.CALLBACK.fetch("http://callback/next-op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txId })
      });
      const cmd = await stepRes.json();
      if (cmd.type === "exec") {
        try {
          const result = this.#execSql(cmd.query, cmd.bindings);
          await this.env.CALLBACK.fetch("http://callback/op-result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ txId, result })
          });
        } catch (err) {
          await this.env.CALLBACK.fetch("http://callback/op-result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              txId,
              result: {
                ok: false,
                message: err instanceof Error ? err.message : String(err)
              }
            })
          });
        }
      } else if (cmd.type === "nested-tx") {
        try {
          await this.ctx.storage.transaction(async (childTxn) => {
            await this.#runTransactionLoop(cmd.childTxId, childTxn);
          });
          await this.env.CALLBACK.fetch("http://callback/op-result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ txId, result: { ok: true } })
          });
        } catch (err) {
          await this.env.CALLBACK.fetch("http://callback/op-result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              txId,
              result: {
                ok: false,
                message: err instanceof Error ? err.message : String(err)
              }
            })
          });
        }
      } else if (cmd.type === "rollback") {
        try {
          txn.rollback();
        } catch {
          // ignore duplicate rollback errors cleanly
        }
        await this.env.CALLBACK.fetch("http://callback/op-result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ txId, result: { ok: true } })
        });
        return;
      } else if (cmd.type === "commit") {
        return;
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/exec") {
      const { query, bindings } = await request.json();
      try {
        return Response.json(this.#execSql(query, bindings));
      } catch (err) {
        return Response.json({
          ok: false,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
    if (url.pathname === "/transaction") {
      const { txId } = await request.json();
      try {
        await this.ctx.storage.transaction(async (txn) => {
          await this.#runTransactionLoop(txId, txn);
        });
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({
          ok: false,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const doName = request.headers.get("x-do-name") || "default";
    const id = env.DO.idFromName(doName);
    return env.DO.get(id).fetch(request);
  }
};
`

const BRIDGE_WORKER_SCRIPT = `
const { parentPort } = require("node:worker_threads");
const http = require("node:http");

const pendingNextOp = new Map();
const pendingOpResult = new Map();
const pendingTxComplete = new Map();
let workerdPort = 0;

const callbackServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    if (req.url === "/next-op") {
      pendingNextOp.set(parsed.txId, (cmd) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(cmd));
      });
      const readyWaiter = pendingOpResult.get(parsed.txId + ":ready");
      if (readyWaiter) {
        pendingOpResult.delete(parsed.txId + ":ready");
        readyWaiter({ ok: true });
      }
    } else if (req.url === "/op-result") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ack: true }));
      const waiter = pendingOpResult.get(parsed.txId);
      if (waiter) {
        pendingOpResult.delete(parsed.txId);
        waiter(parsed.result);
      }
    }
  });
});

const waitForNextOp = (txId) =>
  new Promise((resolve) => {
    if (pendingNextOp.has(txId)) {
      resolve({ ok: true });
    } else {
      pendingOpResult.set(txId + ":ready", resolve);
    }
  });

const sendOpAndWait = (txId, cmd) =>
  new Promise((resolve) => {
    const respond = pendingNextOp.get(txId);
    pendingNextOp.delete(txId);
    pendingOpResult.set(txId, resolve);
    respond(cmd);
  });

callbackServer.listen(0, "127.0.0.1", () => {
  const callbackPort = callbackServer.address().port;
  parentPort.postMessage({ type: "ready", callbackPort });
});

parentPort.on("message", async (msg) => {
  if (msg.type === "set-workerd-port") {
    workerdPort = msg.workerdPort;
    if (msg.port) {
      msg.port.postMessage({ ok: true });
    }
    if (msg.sab) {
      const i32 = new Int32Array(msg.sab);
      Atomics.store(i32, 0, 1);
      Atomics.notify(i32, 0);
    }
    return;
  }

  const finishSync = (result) => {
    msg.port.postMessage(result);
    const i32 = new Int32Array(msg.sab);
    Atomics.store(i32, 0, 1);
    Atomics.notify(i32, 0);
  };

  try {
    if (msg.type === "exec") {
      if (msg.txId) {
        await waitForNextOp(msg.txId);
        const result = await sendOpAndWait(msg.txId, {
          type: "exec",
          query: msg.query,
          bindings: msg.bindings
        });
        finishSync(result);
      } else {
        const res = await fetch("http://127.0.0.1:" + workerdPort + "/exec", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-do-name": msg.doName
          },
          body: JSON.stringify({ query: msg.query, bindings: msg.bindings })
        });
        const result = await res.json();
        finishSync(result);
      }
    } else if (msg.type === "begin-tx") {
      if (msg.parentTxId) {
        await waitForNextOp(msg.parentTxId);
        const respondParent = pendingNextOp.get(msg.parentTxId);
        pendingNextOp.delete(msg.parentTxId);
        const nestedDone = new Promise((resolve) => {
          pendingOpResult.set(msg.parentTxId, resolve);
        });
        pendingTxComplete.set(msg.txId, nestedDone);
        respondParent({ type: "nested-tx", childTxId: msg.txId });
        await waitForNextOp(msg.txId);
        finishSync({ ok: true });
      } else {
        const txPromise = fetch("http://127.0.0.1:" + workerdPort + "/transaction", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-do-name": msg.doName
          },
          body: JSON.stringify({ txId: msg.txId })
        }).then((r) => r.json());
        pendingTxComplete.set(msg.txId, txPromise);
        await waitForNextOp(msg.txId);
        finishSync({ ok: true });
      }
    } else if (msg.type === "commit-tx") {
      await waitForNextOp(msg.txId);
      const respond = pendingNextOp.get(msg.txId);
      pendingNextOp.delete(msg.txId);
      respond({ type: "commit" });
      const txDone = pendingTxComplete.get(msg.txId);
      pendingTxComplete.delete(msg.txId);
      const finalRes = txDone ? await txDone : { ok: true };
      finishSync(finalRes);
    } else if (msg.type === "rollback-tx") {
      await waitForNextOp(msg.txId);
      await sendOpAndWait(msg.txId, { type: "rollback" });
      const txDone = pendingTxComplete.get(msg.txId);
      pendingTxComplete.delete(msg.txId);
      if (txDone) {
        await txDone;
      }
      finishSync({ ok: true });
    }
  } catch (err) {
    finishSync({
      ok: false,
      message: err instanceof Error ? err.message : String(err)
    });
  }
});
`

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
let activeRefCount = 0
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null

const closeSharedBridge = (bridgeToClose: SharedWorkerdBridge): void => {
  void Effect.runPromise(Scope.close(bridgeToClose.scope, Exit.void))
    .finally(() => bridgeToClose.worker.terminate())
    .finally(() => {
      rmSync(bridgeToClose.tmpDir, { recursive: true, force: true })
    })
}

const acquireSharedWorkerdBridge = (): Effect.Effect<SharedWorkerdBridge, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      if (idleCloseTimer !== null) {
        clearTimeout(idleCloseTimer)
        idleCloseTimer = null
      }
      activeRefCount += 1
      if (activeBridge !== null) {
        return activeBridge
      }

      const tmpDir = mkdtempSync(join(tmpdir(), "harness-es-workerd-"))
      const bridgeScope = yield* Scope.make()

      const { callbackPort, worker } = yield* Effect.callback<{
        readonly callbackPort: number
        readonly worker: Worker
      }>((resume) => {
        const w = new Worker(BRIDGE_WORKER_SCRIPT, { eval: true })
        w.once("message", (msg: { readonly callbackPort: number }) => {
          resume(Effect.succeed({ callbackPort: msg.callbackPort, worker: w }))
        })
        w.once("error", (err) => {
          resume(Effect.die(err))
        })
      })

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
        .pipe(Scope.provide(bridgeScope), Effect.orDie)

      const callSync = (payload: Record<string, unknown>): BridgeExecResult => {
        const sab = new SharedArrayBuffer(4)
        const i32 = new Int32Array(sab)
        const { port1, port2 } = new MessageChannel()
        worker.postMessage({ ...payload, sab, port: port2 }, [port2])
        Atomics.wait(i32, 0, 0)
        const received = receiveMessageOnPort(port1)
        port1.close()
        if (received === undefined) {
          return { ok: false, message: "No response received from workerd bridge" }
        }
        return received.message as BridgeExecResult
      }

      callSync({ type: "set-workerd-port", workerdPort: ports.main })

      const bridge: SharedWorkerdBridge = {
        worker,
        scope: bridgeScope,
        tmpDir,
        callSync,
      }
      activeBridge = bridge
      return bridge
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

      const safeRollback = (): void => {
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
            txStack.pop()
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
            txStack.pop()
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
