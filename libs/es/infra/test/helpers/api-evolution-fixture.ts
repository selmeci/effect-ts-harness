import { FileSystem, Layer, Path, Schema } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { PositiveInt } from "@harness/es-contract"
import { ItemCount } from "@harness/es-core/fixtures/cart"
import { SqlClientMemoryLayer } from "../../src/memory.js"
import { makeCartApiLayer } from "../fixtures/cart-sqlite.js"

export const positiveInt = Schema.decodeSync(PositiveInt)
export const itemCount = Schema.decodeSync(ItemCount)

export const TestEnv = Layer.mergeAll(
  SqlClientMemoryLayer,
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer,
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

export const cartApiLayer = makeCartApiLayer.pipe(HttpRouter.provideRequest(SqlClientMemoryLayer))
