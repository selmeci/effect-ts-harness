export const DO_WORKER_ES_MODULE = `
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/rollback|closed|finished|inactive/i.test(msg)) {
            await this.env.CALLBACK.fetch("http://callback/op-result", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ txId, result: { ok: false, message: msg } })
            });
            return;
          }
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

export const BRIDGE_WORKER_SCRIPT = `
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
