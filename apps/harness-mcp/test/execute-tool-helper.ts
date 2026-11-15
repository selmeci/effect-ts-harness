import { Effect } from "effect"
import { executeToolEffect } from "../src/server.js"
import type { ServerOptions } from "../src/tools/mcp-helpers.js"

export const executeTool = (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  options?: ServerOptions,
): Promise<unknown> =>
  Effect.runPromise(
    executeToolEffect(toolName, args, {
      skipOmnigraphSpawn: true,
      skipTelemetry: options?.repoRoot === undefined,
      skipActiveWorkspaceLookup: true,
      ...options,
    }),
  )
