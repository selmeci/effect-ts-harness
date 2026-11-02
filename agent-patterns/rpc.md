# Type-Safe RPC over Durable Objects

Internal service communication uses RpcGroup and Rpc over Cloudflare toHttpClient with W3C traceparent propagation into Durable Objects.

## Defining RPC Groups in `type:contract`

Use `RpcGroup` and `Rpc` to declare internal procedure interfaces between Workers and Durable Objects:

```ts
import { Rpc, RpcGroup } from "effect/rpc"
import { Schema } from "effect"
import { SessionData, SessionError } from "contract/session"

export class SessionRpcGroup extends RpcGroup.make("SessionRpc")
  .add(
    Rpc.make("getSession")
      .setPayload(Schema.Struct({ sessionId: Schema.String }))
      .setSuccess(SessionData)
      .setError(SessionError),
  )
  .add(
    Rpc.make("touchSession")
      .setPayload(Schema.Struct({ sessionId: Schema.String }))
      .setSuccess(Schema.Void)
      .setError(SessionError),
  ) {}
```

## Durable Object RPC Client over `toHttpClient(doStub)`

To communicate from a Worker to a Durable Object while propagating W3C `traceparent` distributed tracing headers, wrap the DO stub with `Cloudflare.toHttpClient`:

```ts
import { Effect, Layer } from "effect"
import { RpcClient } from "effect/rpc"
import { SessionRpcGroup } from "contract/session-rpc"

export const makeSessionClient = (doStub: DurableObjectStub) =>
  Effect.gen(function* () {
    // Convert Cloudflare DO stub to an Effect HttpClient that propagates W3C traceparent headers
    const httpClient = yield* Cloudflare.toHttpClient(doStub)

    // Build the typed RpcClient using the contract definition and http client
    const client = RpcClient.make(SessionRpcGroup, {
      httpClient,
    })

    return client
  })
```

## Implementing the Server in the Durable Object

Implement the RPC handlers inside the Durable Object in `type:infra`:

```ts
import { RpcServer } from "effect/rpc"
import { Effect } from "effect"
import { SessionRpcGroup } from "contract/session-rpc"

export const SessionRpcRouter = RpcServer.make(SessionRpcGroup, {
  getSession: ({ sessionId }) =>
    Effect.gen(function* () {
      const session = yield* readSessionFromStorage(sessionId)
      return session
    }),
  touchSession: ({ sessionId }) =>
    Effect.gen(function* () {
      yield* updateSessionTimestamp(sessionId)
    }),
})
```

## W3C Trace Propagation

Propagating the W3C `traceparent` header across the Worker-to-Durable-Object boundary ensures that:

1. Tracing spans in the Worker and Durable Object share the same trace ID.
2. Dual-graph ingestion (`@harness/ingest`) correctly links caller and callee nodes via `TracedCall` edges.
