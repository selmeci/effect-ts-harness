import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { isPureInterruptCause } from "@harness/contract"
import {
  type HarnessDaemonServerHandle,
  startHarnessDaemonServer,
} from "./daemon/unix-socket-daemon.js"
import { launchBackgroundOllamaWarmup } from "./managed-runtime.js"
import { resolveDaemonStartupRepoRoot } from "./tools/mcp-repo-root.js"

/** Runs the stdio MCP transport, daemon socket listener, background Ollama warmup, and graceful shutdown handlers. */
export const runMcpStdioMain = (server: McpServer): void => {
  const transport = new StdioServerTransport()
  const cliRuntime = ManagedRuntime.make(NodeServices.layer)
  const startupRepoRoot = resolveDaemonStartupRepoRoot(process.cwd())
  let daemonHandle: HarnessDaemonServerHandle | undefined = undefined
  let shuttingDown = false
  launchBackgroundOllamaWarmup(cliRuntime, startupRepoRoot)
  const daemonStartupPromise: Promise<HarnessDaemonServerHandle | undefined> =
    process.env.HARNESS_DAEMON_SOCK !== "0"
      ? startHarnessDaemonServer(startupRepoRoot, {
          workflowEngine: { mode: "auto" },
        })
          .then((handle) => {
            daemonHandle = handle
            return handle
          })
          .catch((err: unknown) => {
            process.stderr.write(
              `[harness-mcp] Daemon server warning: ${err instanceof Error ? err.message : String(err)}\n`,
            )
            return undefined
          })
      : Promise.resolve(undefined)
  const shutdown = (initialExitCode = 0) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    let exitCode = initialExitCode
    void daemonStartupPromise
      .then((startedHandle) => {
        const handleToClose = daemonHandle ?? startedHandle
        if (handleToClose === undefined) {
          return Promise.resolve()
        }
        return handleToClose.close().catch((err: unknown) => {
          exitCode = 1
          process.stderr.write(
            `[harness-mcp] Daemon close error: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        })
      })
      .then(() =>
        server.close().catch((err: unknown) => {
          exitCode = 1
          process.stderr.write(
            `[harness-mcp] Server close error: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }),
      )
      .then(() =>
        cliRuntime.dispose().catch((err: unknown) => {
          exitCode = 1
          process.stderr.write(
            `[harness-mcp] CLI runtime dispose error: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }),
      )
      .finally(() => process.exit(exitCode))
  }
  process.once("SIGINT", () => shutdown(0))
  process.once("SIGTERM", () => shutdown(0))
  process.stdin.once("end", () => shutdown(0))
  process.stdin.once("close", () => shutdown(0))
  void cliRuntime.runPromiseExit(Effect.tryPromise(() => server.connect(transport))).then((exit) =>
    Exit.match(exit, {
      onFailure: (cause) => {
        if (isPureInterruptCause(cause)) return
        const squashed = Cause.squash(cause)
        process.stderr.write(
          `[harness-mcp] Fatal error: ${squashed instanceof Error ? squashed.message : String(squashed)}\n`,
        )
        shutdown(1)
      },
      onSuccess: () => {
        const previousTransportOnClose = transport.onclose
        transport.onclose = () => {
          previousTransportOnClose?.()
          shutdown(0)
        }
      },
    }),
  )
}
