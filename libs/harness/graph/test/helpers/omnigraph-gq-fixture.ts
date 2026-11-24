import { Schema } from "effect"
import { makeOmnigraphSyncLayer } from "../../src/index.js"
import { testHostIo } from "./test-host-io.js"

export const OmnigraphSyncLive = makeOmnigraphSyncLayer(testHostIo)

export const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly body?: string | undefined
}

export const toUrlString = (input: string | URL | Request): string => {
  if (typeof input === "string") return input
  if ("url" in input) return input.url
  return input.href
}
