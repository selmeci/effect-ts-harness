import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Schema, Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiTest } from "effect/http-api"
import { AtomRegistry } from "effect/reactivity"
import {
  AggregateCommandResult,
  AggregateId,
  AggregateName,
  CommandAggregateMismatchError,
  CommandId,
  CrossProjectionNotFoundError,
  EventSerializationError,
  EventStreamCorruptionError,
  LocalProjectionNotFoundError,
  ProcessorId,
  ProjectionName,
  StreamVersion,
} from "@harness/es-contract"
import { makeAggregateApiTestHarness } from "@harness/es-core"
import {
  CartAlreadyCheckedOutError,
  type CartCommandV2,
  CartEventV2,
  CartId,
  CheckoutChannel,
  EmptyCartCheckoutError,
  ItemId,
  OrderId,
} from "@harness/es-core/fixtures/cart"
import { match } from "ts-pattern"
import {
  executeAggregateCommandAndSync,
  handleAggregateCommand,
  initializeAggregateTables,
  initializeProjectorTables,
  loadAggregate,
  queryAggregateReadModel,
  queryCrossAggregateReadModel,
  rebuildProjectorFromArchive,
  relayAggregateOutbox,
  seedAggregateStream,
} from "../src/index.js"
import {
  cartAggregateConfig,
  cartAggregateConfigV2,
  type CartCommandResponseV2,
  CartEsApi,
  CartEsAtomClient,
  cartEsHttpClientAtom,
  cartViewV2Projection,
  initCartViewTable,
  initCartViewV2Table,
  initOpenCartsProjectionTable,
  openCartsProjection,
  openCartsProjectionV2,
} from "./fixtures/cart-sqlite.js"
import { positiveInt, itemCount, TestEnv, cartApiLayer } from "./helpers/api-evolution-fixture.js"

describe("Aggregate HTTP & Evolution Specs", () => {
  it.effect(
    "REQ-2.1: upcasts v1 stored events to v2 on aggregate load and projection rebuild without mutating SQLite rows",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initCartViewTable
        yield* initCartViewV2Table
        const sql = yield* SqlClient

        const cartId = AggregateId.make("cart-evolve-1")
        const cmd1 = {
          _tag: "AddItem",
          cartId: CartId.make("cart-evolve-1"),
          itemId: ItemId.make("item-1"),
          quantity: positiveInt(2),
        } as const
        yield* handleAggregateCommand(cartId, cmd1, CommandId.make("cmd-v1-1"), cartAggregateConfig)

        const cmd2 = {
          _tag: "Checkout",
          cartId: CartId.make("cart-evolve-1"),
          orderId: OrderId.make("order-1"),
        } as const
        yield* handleAggregateCommand(cartId, cmd2, CommandId.make("cmd-v1-2"), cartAggregateConfig)

        // Raw row in SQLite should have version 1 and no checkoutChannel
        const rows = yield* sql<{ payload: string; stream_version: number; event_type: string }>`
          SELECT payload, stream_version, event_type FROM es_events
          WHERE aggregate_id = ${cartId} AND stream_version = 3
        `
        expect(rows.length).toBe(1)
        expect(rows[0]?.event_type).toBe("CartCheckedOut")
        const rawPayload = JSON.parse(rows[0]!.payload)
        expect(rawPayload.version).toBe(1)
        expect(rawPayload.channel).toBeUndefined()

        // Aggregate load via v2 config decodes through the upcaster
        const loaded = yield* loadAggregate(cartId, cartAggregateConfigV2)
        expect(loaded.currentVersion).toBe(3)
        match(loaded.state)
          .with({ _tag: "CheckedOutCart" }, (checkedOut) => {
            expect(checkedOut.orderId).toBe("order-1")
            expect(checkedOut.channel).toBe("web")
          })
          .otherwise(() => {
            expect.unreachable("expected CheckedOutCart state")
          })

        // Local projection query reflects the upcasted channel
        const view = yield* queryAggregateReadModel(
          cartId,
          ProjectionName.make("CartView"),
          cartAggregateConfigV2,
          [cartViewV2Projection],
        )
        expect(view.cartId).toBe(cartId)
        expect(view.status).toBe("checked_out")
        expect(view.checkoutChannel).toBe("web")

        // Persisted SQLite row remains intact as version 1
        const rowsAfter = yield* sql<{ payload: string; stream_version: number }>`
          SELECT payload, stream_version FROM es_events
          WHERE aggregate_id = ${cartId} AND stream_version = 3
        `
        expect(rowsAfter.length).toBe(1)
        const rawPayloadAfter = JSON.parse(rowsAfter[0]!.payload)
        expect(rawPayloadAfter.version).toBe(1)
        expect(rawPayloadAfter.channel).toBeUndefined()
      }).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "REQ-2.2: cross-aggregate projector live ingestion and archive rebuild across mixed v1 and v2 events",
    () =>
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initializeProjectorTables()
        yield* initCartViewTable
        yield* initCartViewV2Table
        yield* initOpenCartsProjectionTable

        // Cart 1: v1 commands ingested live
        const cart1Id = AggregateId.make("cart-cross-1")
        yield* executeAggregateCommandAndSync(
          cart1Id,
          {
            _tag: "AddItem",
            cartId: CartId.make("cart-cross-1"),
            itemId: ItemId.make("item-1"),
            quantity: positiveInt(3),
          },
          CommandId.make("cmd-cross-1-add"),
          { ...cartAggregateConfig, outboxMode: { _tag: "PublishOutbox" } },
        )
        yield* executeAggregateCommandAndSync(
          cart1Id,
          {
            _tag: "Checkout",
            cartId: CartId.make("cart-cross-1"),
            orderId: OrderId.make("order-cross-1"),
          },
          CommandId.make("cmd-cross-1-checkout"),
          { ...cartAggregateConfig, outboxMode: { _tag: "PublishOutbox" } },
        )
        yield* relayAggregateOutbox(AggregateName.make("Cart"), [openCartsProjection])

        // Cart 2: v2 commands with Checkout (mobile) ingested live
        const cart2Id = AggregateId.make("cart-cross-2")
        yield* executeAggregateCommandAndSync(
          cart2Id,
          {
            _tag: "AddItem",
            cartId: CartId.make("cart-cross-2"),
            itemId: ItemId.make("item-2"),
            quantity: positiveInt(5),
          },
          CommandId.make("cmd-cross-2-add"),
          cartAggregateConfigV2,
        )
        yield* executeAggregateCommandAndSync(
          cart2Id,
          {
            _tag: "Checkout",
            cartId: CartId.make("cart-cross-2"),
            orderId: OrderId.make("order-cross-2"),
            channel: CheckoutChannel.make("mobile"),
          },
          CommandId.make("cmd-cross-2-checkout"),
          cartAggregateConfigV2,
        )
        yield* relayAggregateOutbox(AggregateName.make("Cart"), [openCartsProjectionV2])

        // Cart 3: active open cart
        const cart3Id = AggregateId.make("cart-cross-3")
        yield* executeAggregateCommandAndSync(
          cart3Id,
          {
            _tag: "AddItem",
            cartId: CartId.make("cart-cross-3"),
            itemId: ItemId.make("item-3"),
            quantity: positiveInt(2),
          },
          CommandId.make("cmd-cross-3-add"),
          cartAggregateConfigV2,
        )
        yield* relayAggregateOutbox(AggregateName.make("Cart"), [openCartsProjectionV2])

        // Check live report: 3 carts total, cart 3 is active
        const liveReport = yield* queryCrossAggregateReadModel(
          ProcessorId.make("open-carts-v2"),
          undefined,
          [openCartsProjectionV2],
        )
        expect(liveReport.carts.length).toBe(3)
        const activeCart = liveReport.carts.find((c) => c.cartId === "cart-cross-3")
        expect(activeCart?.status).toBe("active")
        expect(activeCart?.totalQuantity).toBe(2)
        const checkedOut1 = liveReport.carts.find((c) => c.cartId === "cart-cross-1")
        expect(checkedOut1?.status).toBe("checked_out")
        const checkedOut2 = liveReport.carts.find((c) => c.cartId === "cart-cross-2")
        expect(checkedOut2?.status).toBe("checked_out")

        // Rebuild projector from archive
        yield* rebuildProjectorFromArchive(openCartsProjectionV2)

        // Query rebuilt report: must match live ingestion exactly
        const rebuiltReport = yield* queryCrossAggregateReadModel(
          ProcessorId.make("open-carts-v2"),
          undefined,
          [openCartsProjectionV2],
        )
        expect(rebuiltReport.carts.length).toBe(3)
        expect(rebuiltReport).toEqual(liveReport)
      }).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "REQ-3.1: AggregateApiSpec asserts response and appended events on successful command execution",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const client = yield* HttpApiTest.groups(CartEsApi, ["carts"]).pipe(
            Effect.provide(cartApiLayer),
          )
          const sql = yield* SqlClient
          const cartId = AggregateId.make("cart-spec-1")

          let seededCount = 0
          const harness = makeAggregateApiTestHarness({
            seedEvents: (history: ReadonlyArray<CartEventV2>) =>
              Effect.gen(function* () {
                yield* seedAggregateStream(cartId, history, cartAggregateConfigV2).pipe(
                  Effect.orDie,
                )
                seededCount = history.length
              }),
            readAppendedEvents: Effect.gen(function* () {
              const rows = yield* sql<{ payload: string }>`
                SELECT payload FROM es_events
                WHERE aggregate_id = ${cartId} AND stream_version > ${seededCount}
                ORDER BY stream_version ASC
              `
              const events: Array<CartEventV2> = []
              for (const r of rows) {
                const parsed = JSON.parse(r.payload)
                const decoded = yield* Schema.decodeUnknownEffect(CartEventV2)(parsed)
                events.push(decoded)
              }
              return events
            }),
          })

          const cmdId1 = CommandId.make("cmd-spec-add-1")
          const addCmd: CartCommandV2 = {
            _tag: "AddItem",
            cartId: CartId.make("cart-spec-1"),
            itemId: ItemId.make("item-spec-1"),
            quantity: positiveInt(4),
          }
          const expectedResponse: CartCommandResponseV2 = {
            state: {
              _tag: "ActiveCart",
              cartId: CartId.make("cart-spec-1"),
              items: [
                {
                  itemId: ItemId.make("item-spec-1"),
                  quantity: positiveInt(4),
                },
              ],
              itemCount: itemCount(4),
            },
            events: [
              {
                _tag: "CartCreated",
                version: 1,
                cartId: CartId.make("cart-spec-1"),
              },
              {
                _tag: "ItemAdded",
                version: 1,
                cartId: CartId.make("cart-spec-1"),
                itemId: ItemId.make("item-spec-1"),
                quantity: positiveInt(4),
              },
            ],
            result: new AggregateCommandResult({
              processingStatus: {
                _tag: "Processed",
              },
              creationStatus: {
                _tag: "CreatedStream",
              },
              nextExpectedStreamVersion: StreamVersion.make(2),
            }),
          }
          const expectedAppended: ReadonlyArray<CartEventV2> = [
            {
              _tag: "CartCreated",
              version: 1,
              cartId: CartId.make("cart-spec-1"),
            },
            {
              _tag: "ItemAdded",
              version: 1,
              cartId: CartId.make("cart-spec-1"),
              itemId: ItemId.make("item-spec-1"),
              quantity: positiveInt(4),
            },
          ]

          yield* harness
            .given([])
            .when(
              client.carts.executeCommand({
                params: { cartId },
                payload: { command: addCmd, commandId: cmdId1 },
              }),
            )
            .thenStatusAndEvents(expectedResponse, expectedAppended)
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect("REQ-3.2: AggregateApiSpec asserts EmptyCartCheckoutError failure via thenFails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* initializeAggregateTables()
        yield* initializeProjectorTables()
        yield* initCartViewV2Table
        yield* initOpenCartsProjectionTable
        const client = yield* HttpApiTest.groups(CartEsApi, ["carts"]).pipe(
          Effect.provide(cartApiLayer),
        )
        const emptyCartId = AggregateId.make("cart-empty-spec")
        const emptyHarness = makeAggregateApiTestHarness({
          seedEvents: (history: ReadonlyArray<CartEventV2>) =>
            seedAggregateStream(emptyCartId, history, cartAggregateConfigV2).pipe(Effect.orDie),
          readAppendedEvents: Effect.succeed<ReadonlyArray<CartEventV2>>([]),
        })
        const emptyCheckoutCmd: CartCommandV2 = {
          _tag: "Checkout",
          cartId: CartId.make("cart-empty-spec"),
          orderId: OrderId.make("order-empty"),
          channel: CheckoutChannel.make("web"),
        }
        yield* emptyHarness
          .given([
            {
              _tag: "CartCreated",
              version: 1,
              cartId: CartId.make("cart-empty-spec"),
            },
          ])
          .when(
            client.carts.executeCommand({
              params: { cartId: emptyCartId },
              payload: {
                command: emptyCheckoutCmd,
                commandId: CommandId.make("cmd-empty-checkout"),
              },
            }),
          )
          .thenFails(new EmptyCartCheckoutError({ cartId: CartId.make("cart-empty-spec") }))
      }),
    ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "REQ-3.2: AggregateApiSpec asserts CartAlreadyCheckedOutError failure via thenFails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const client = yield* HttpApiTest.groups(CartEsApi, ["carts"]).pipe(
            Effect.provide(cartApiLayer),
          )
          const checkedOutCartId = AggregateId.make("cart-checked-out-spec")
          const checkedOutHarness = makeAggregateApiTestHarness({
            seedEvents: (history: ReadonlyArray<CartEventV2>) =>
              seedAggregateStream(checkedOutCartId, history, cartAggregateConfigV2).pipe(
                Effect.orDie,
              ),
            readAppendedEvents: Effect.succeed<ReadonlyArray<CartEventV2>>([]),
          })
          const checkoutCmd2: CartCommandV2 = {
            _tag: "Checkout",
            cartId: CartId.make("cart-checked-out-spec"),
            orderId: OrderId.make("order-2"),
            channel: CheckoutChannel.make("mobile"),
          }
          yield* checkedOutHarness
            .given([
              {
                _tag: "CartCreated",
                version: 1,
                cartId: CartId.make("cart-checked-out-spec"),
              },
              {
                _tag: "ItemAdded",
                version: 1,
                cartId: CartId.make("cart-checked-out-spec"),
                itemId: ItemId.make("item-1"),
                quantity: positiveInt(1),
              },
              {
                _tag: "CartCheckedOut",
                version: 2,
                cartId: CartId.make("cart-checked-out-spec"),
                orderId: OrderId.make("order-1"),
                channel: CheckoutChannel.make("web"),
              },
            ])
            .when(
              client.carts.executeCommand({
                params: { cartId: checkedOutCartId },
                payload: {
                  command: checkoutCmd2,
                  commandId: CommandId.make("cmd-checked-out"),
                },
              }),
            )
            .thenFails(
              new CartAlreadyCheckedOutError({ cartId: CartId.make("cart-checked-out-spec") }),
            )
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "REQ-3.3: HttpApi executeCommand fails with CommandAggregateMismatchError when reusing commandId across distinct aggregates",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const client = yield* HttpApiTest.groups(CartEsApi, ["carts"]).pipe(
            Effect.provide(cartApiLayer),
          )
          const cartId1 = AggregateId.make("cart-spec-orig")
          const cartId2 = AggregateId.make("cart-spec-other")
          const sharedCmdId = CommandId.make("cmd-spec-shared")

          // Execute on cart 1 first
          yield* client.carts.executeCommand({
            params: { cartId: cartId1 },
            payload: {
              command: {
                _tag: "AddItem",
                cartId: CartId.make("cart-spec-orig"),
                itemId: ItemId.make("item-1"),
                quantity: positiveInt(1),
              },
              commandId: sharedCmdId,
            },
          })

          // Attempt to reuse sharedCmdId on cart 2
          const mismatchExit = yield* client.carts
            .executeCommand({
              params: { cartId: cartId2 },
              payload: {
                command: {
                  _tag: "AddItem",
                  cartId: CartId.make("cart-spec-other"),
                  itemId: ItemId.make("item-1"),
                  quantity: positiveInt(1),
                },
                commandId: sharedCmdId,
              },
            })
            .pipe(Effect.exit)
          match(mismatchExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof CommandAggregateMismatchError).toBe(true)
                })
                .with({ _tag: "None" }, () => expect.unreachable("expected typed error"))
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "REQ-4.1, REQ-4.2, REQ-4.3 & REQ-4.4: AtomHttpApi reactive client issues commands and reads single & cross projections, testing projection errors",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          // In-memory HTTP client connecting AtomHttpApi directly to CartEsApi handlers
          const layer = HttpApiBuilder.layer(CartEsApi).pipe(Layer.provide(cartApiLayer))
          const handler = yield* HttpRouter.toHttpEffect(layer)
          const scope = yield* Effect.scope
          const testHttpClient = HttpClient.make((request) => {
            const requestScope = Scope.forkUnsafe(scope)
            const serverRequest = HttpServerRequest.fromClientRequest(request)
            return handler.pipe(
              Effect.map((response) => HttpServerResponse.toClientResponse(response, { request })),
              Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
              Effect.provideService(Scope.Scope, requestScope),
              Effect.orDie,
              Effect.onExit((exit) => Scope.close(requestScope, exit)),
            )
          })

          const registry = AtomRegistry.make()
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()))
          registry.set(cartEsHttpClientAtom, Layer.succeed(HttpClient.HttpClient, testHttpClient))

          // Mutation: AddItem
          const mutation = CartEsAtomClient.mutation("carts", "executeCommand")
          yield* AtomRegistry.mount(registry, mutation)

          const cartId = AggregateId.make("cart-atom-1")
          const cmdId1 = CommandId.make("cmd-atom-1")
          registry.set(mutation, {
            params: { cartId },
            payload: {
              command: {
                _tag: "AddItem",
                cartId: CartId.make("cart-atom-1"),
                itemId: ItemId.make("item-atom-1"),
                quantity: positiveInt(3),
              },
              commandId: cmdId1,
            },
          })
          const mutationRes1 = yield* AtomRegistry.getResult(registry, mutation, {
            suspendOnWaiting: true,
          })
          expect(mutationRes1.result.creationStatus._tag).toBe("CreatedStream")
          expect(mutationRes1.result.nextExpectedStreamVersion).toBe(2)

          // Query: Single-aggregate view
          const cartViewQuery = CartEsAtomClient.query("carts", "getCartView", {
            params: { cartId },
            reactivityKeys: ["carts"],
          })
          yield* AtomRegistry.mount(registry, cartViewQuery)
          const viewResult = yield* AtomRegistry.getResult(registry, cartViewQuery, {
            suspendOnWaiting: true,
          })
          expect(viewResult.cartId).toBe(cartId)
          expect(viewResult.status).toBe("active")
          expect(viewResult.itemCount).toBe(1)
          expect(viewResult.totalQuantity).toBe(3)
          expect(viewResult.checkoutChannel).toBeUndefined()

          // Query: Cross-aggregate open carts report
          const openCartsQuery = CartEsAtomClient.query("carts", "getOpenCarts", {
            reactivityKeys: ["carts"],
          })
          yield* AtomRegistry.mount(registry, openCartsQuery)
          const reportResult = yield* AtomRegistry.getResult(registry, openCartsQuery, {
            suspendOnWaiting: true,
          })
          expect(reportResult.carts.length).toBe(1)
          expect(reportResult.carts[0]?.cartId).toBe("cart-atom-1")
          expect(reportResult.carts[0]?.totalQuantity).toBe(3)

          // Mutation: Checkout with channel "mobile"
          registry.set(mutation, {
            params: { cartId },
            payload: {
              command: {
                _tag: "Checkout",
                cartId: CartId.make("cart-atom-1"),
                orderId: OrderId.make("order-atom-1"),
                channel: CheckoutChannel.make("mobile"),
              },
              commandId: CommandId.make("cmd-atom-2"),
            },
          })
          const mutationRes2 = yield* AtomRegistry.getResult(registry, mutation, {
            suspendOnWaiting: true,
          })
          expect(mutationRes2.result.processingStatus._tag).toBe("Processed")
          expect(mutationRes2.result.nextExpectedStreamVersion).toBe(3)

          // Query: Single-aggregate view after checkout reflects "CheckedOut" and "mobile"
          registry.refresh(cartViewQuery)
          const viewResult2 = yield* AtomRegistry.getResult(registry, cartViewQuery, {
            suspendOnWaiting: true,
          })
          expect(viewResult2.status).toBe("checked_out")
          expect(viewResult2.checkoutChannel).toBe("mobile")

          const v2EventRows = yield* sql<{ payload: string }>`
            SELECT payload FROM es_events
            WHERE aggregate_id = ${cartId} AND event_type = 'CartCheckedOut'
          `
          expect(v2EventRows.length).toBe(1)
          const rawV2Payload = JSON.parse(v2EventRows[0]!.payload) as {
            readonly _tag: string
            readonly version: number
            readonly channel: string
          }
          expect(rawV2Payload._tag).toBe("CartCheckedOut")
          expect(rawV2Payload.version).toBe(2)
          expect(rawV2Payload.channel).toBe("mobile")

          yield* sql`DELETE FROM projection_cart_view_v2 WHERE cart_id = ${cartId}`
          yield* sql`DELETE FROM es_projections_meta WHERE aggregate_id = ${cartId}`
          const reloadedView = yield* queryAggregateReadModel(
            cartId,
            ProjectionName.make("CartView"),
            cartAggregateConfigV2,
            [cartViewV2Projection],
          )
          expect(reloadedView.status).toBe("checked_out")
          expect(reloadedView.checkoutChannel).toBe("mobile")

          // Error: LocalProjectionNotFoundError
          const missingLocalExit = yield* queryAggregateReadModel(
            cartId,
            ProjectionName.make("NonExistentProjection"),
            cartAggregateConfigV2,
            [cartViewV2Projection],
          ).pipe(Effect.exit)
          match(missingLocalExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof LocalProjectionNotFoundError).toBe(true)
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected LocalProjectionNotFoundError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()

          // Error: CrossProjectionNotFoundError
          const missingCrossExit = yield* queryCrossAggregateReadModel(
            ProcessorId.make("non-existent-processor"),
            undefined,
            [openCartsProjectionV2],
          ).pipe(Effect.exit)
          match(missingCrossExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof CrossProjectionNotFoundError).toBe(true)
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected CrossProjectionNotFoundError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "seedAggregateStream returns StreamVersion, writes es_outbox, updates local projection, and empty [] returns current head",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          yield* initCartViewV2Table
          yield* initOpenCartsProjectionTable
          const sql = yield* SqlClient

          const seedCartId = AggregateId.make("cart-seed-direct")
          const emptyVer0 = yield* seedAggregateStream(seedCartId, [], cartAggregateConfigV2)
          expect(emptyVer0).toBe(0)

          const verAfterSeed = yield* seedAggregateStream(
            seedCartId,
            [
              {
                _tag: "CartCreated" as const,
                version: 1 as const,
                cartId: CartId.make("cart-seed-direct"),
              },
              {
                _tag: "ItemAdded" as const,
                version: 1 as const,
                cartId: CartId.make("cart-seed-direct"),
                itemId: ItemId.make("item-seed-1"),
                quantity: positiveInt(2),
              },
            ],
            cartAggregateConfigV2,
          )
          expect(verAfterSeed).toBe(2)

          const emptyVerAfterSeed = yield* seedAggregateStream(
            seedCartId,
            [],
            cartAggregateConfigV2,
          )
          expect(emptyVerAfterSeed).toBe(2)

          const outboxRows = yield* sql<{ stream_version: number }>`
            SELECT stream_version FROM es_outbox
            WHERE aggregate_id = ${seedCartId}
            ORDER BY stream_version ASC
          `
          expect(outboxRows.map((r) => r.stream_version)).toEqual([1, 2])

          const localView = yield* queryAggregateReadModel(
            seedCartId,
            ProjectionName.make("CartView"),
            cartAggregateConfigV2,
            [cartViewV2Projection],
          )
          expect(localView.itemCount).toBe(1)
          expect(localView.totalQuantity).toBe(2)

          const verAfterSecondSeed = yield* seedAggregateStream(
            seedCartId,
            [
              {
                _tag: "CartCheckedOut" as const,
                version: 2 as const,
                cartId: CartId.make("cart-seed-direct"),
                orderId: OrderId.make("order-seed-1"),
                channel: CheckoutChannel.make("mobile"),
              },
            ],
            cartAggregateConfigV2,
          )
          expect(verAfterSecondSeed).toBe(3)

          const localView2 = yield* queryAggregateReadModel(
            seedCartId,
            ProjectionName.make("CartView"),
            cartAggregateConfigV2,
            [cartViewV2Projection],
          )
          expect(localView2.status).toBe("checked_out")
          expect(localView2.checkoutChannel).toBe("mobile")
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "seedAggregateStream fails with EventStreamCorruptionError when max(stream_version) is corrupt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()
          const sql = yield* SqlClient

          const corruptSeedCartId = AggregateId.make("cart-seed-corrupt")
          yield* sql`
            INSERT INTO es_events (
              aggregate_name, aggregate_id, stream_version, command_id, event_type, payload, metadata, created_at
            ) VALUES (
              'Cart', ${corruptSeedCartId}, -1, 'cmd-corrupt', 'CartCreated', '{}', '{}', 1000
            )
          `
          const corruptSeedExit = yield* seedAggregateStream(
            corruptSeedCartId,
            [
              {
                _tag: "CartCreated",
                version: 1,
                cartId: CartId.make("cart-seed-corrupt"),
              },
            ],
            cartAggregateConfigV2,
          ).pipe(Effect.exit)
          match(corruptSeedExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof EventStreamCorruptionError).toBe(true)
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected EventStreamCorruptionError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    "seedAggregateStream fails with EventSerializationError when event fails schema encoding",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* initializeAggregateTables()
          yield* initializeProjectorTables()

          const RejectingCartEventSchema = CartEventV2.pipe(
            Schema.check(Schema.makeFilter(() => "Simulated serialization failure")),
          )
          const badSchemaConfig = {
            ...cartAggregateConfigV2,
            eventSchema: RejectingCartEventSchema,
          }
          const serExit = yield* seedAggregateStream(
            AggregateId.make("cart-seed-ser-err"),
            [
              {
                _tag: "CartCreated",
                version: 1,
                cartId: CartId.make("cart-seed-ser-err"),
              },
            ],
            badSchemaConfig,
          ).pipe(Effect.exit)
          match(serExit)
            .with({ _tag: "Failure" }, (f) => {
              const err = Cause.findErrorOption(f.cause)
              match(err)
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value instanceof EventSerializationError).toBe(true)
                })
                .with({ _tag: "None" }, () =>
                  expect.unreachable("expected EventSerializationError"),
                )
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => expect.unreachable("expected failure"))
            .exhaustive()
        }),
      ).pipe(Effect.provide(TestEnv)),
  )
})
