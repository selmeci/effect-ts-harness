import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Cause, type Exit, type ManagedRuntime, Schema } from "effect"
import { match } from "ts-pattern"
import {
  DocTreePathError,
  EmbeddingProviderError,
  GitDiffExecutionError,
  InvalidReviewRouteInputError,
} from "@harness/contract"

/**
 * Maps an Effect `Exit` from an MCP tool handler to an MCP protocol result or `McpError`.
 */
export const formatMcpToolExit = (
  toolName: string,
  exit: Exit.Exit<unknown, unknown>,
):
  | {
      readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
      readonly isError?: boolean
    }
  | Promise<never> =>
  match(exit)
    .with({ _tag: "Success" }, ({ value }) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }],
    }))
    .with({ _tag: "Failure" }, ({ cause }) => {
      if (Cause.hasInterrupts(cause) && !Cause.hasFails(cause) && !Cause.hasDies(cause)) {
        return Promise.reject(
          new McpError(ErrorCode.InternalError, `Tool '${toolName}' execution was interrupted`),
        )
      }
      const squashed = Cause.squash(cause)
      if (Schema.isSchemaError(squashed)) {
        return Promise.reject(
          new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments for tool '${toolName}': ${squashed.message}`,
          ),
        )
      }
      if (squashed instanceof InvalidReviewRouteInputError) {
        return {
          content: [{ type: "text" as const, text: squashed.reason }],
          isError: true,
        }
      }
      if (squashed instanceof DocTreePathError) {
        return {
          content: [{ type: "text" as const, text: `${squashed._tag}: ${squashed.reason}` }],
          isError: true,
        }
      }
      if (squashed instanceof EmbeddingProviderError) {
        return {
          content: [{ type: "text" as const, text: `${squashed._tag}: ${squashed.reason}` }],
          isError: true,
        }
      }
      if (squashed instanceof GitDiffExecutionError) {
        return {
          content: [{ type: "text" as const, text: squashed.reason }],
          isError: true,
        }
      }
      const message = squashed instanceof Error ? squashed.message : String(squashed)
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      }
    })
    .exhaustive()

/**
 * Ensures the MCP server's managed Effect runtime is disposed once when the server closes.
 */
export const attachServerCloseRuntimeDisposal = <A, E>(
  server: McpServer,
  runtime: ManagedRuntime.ManagedRuntime<A, E>,
): void => {
  const originalClose = server.close.bind(server)
  let disposePromise: Promise<void> | undefined
  const disposeRuntime = (): Promise<void> => {
    if (disposePromise === undefined) {
      disposePromise = runtime.dispose().catch((err: unknown) => {
        disposePromise = undefined
        return Promise.reject(err)
      })
    }
    return disposePromise
  }
  server.close = (): Promise<void> => originalClose().finally(() => disposeRuntime())
  const previousOnClose = server.server.onclose
  server.server.onclose = () => {
    previousOnClose?.()
    void disposeRuntime().catch((err: unknown) => {
      process.stderr.write(
        `[harness-mcp] Runtime dispose error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    })
  }
}
