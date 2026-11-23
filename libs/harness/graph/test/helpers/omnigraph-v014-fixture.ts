import { WorkspaceFilePath } from "@harness/contract"
import { type FetchLike } from "@modernrelay/omnigraph"
import { buildHarnessGraph, makeOmnigraphSyncLayer, PackageTag } from "../../src/index.js"
import { testHostIo } from "./test-host-io.js"

export const OmnigraphSyncLive = makeOmnigraphSyncLayer(testHostIo)

export const jsonResponse = (body: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Omnigraph-Http-Api": "0.14",
        ...extraHeaders,
      },
    }),
  )

export const sampleGraph = buildHarnessGraph({
  fns: [
    {
      qualname: "libs/sample/src/fn.ts#Sample.ping",
      spanName: "Sample.ping",
      packageTag: PackageTag.make("domain"),
      file: WorkspaceFilePath.make("libs/sample/src/fn.ts"),
      line: 10,
      isStub: false,
    },
  ],
})

export const toUrlString = (input: Parameters<FetchLike>[0]): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}
