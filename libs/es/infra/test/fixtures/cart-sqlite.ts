import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api"
import { Atom, AtomHttpApi } from "effect/reactivity"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  AggregateId,
  AggregateName,
  AggregateNotFoundError,
  CommandAggregateMismatchError,
  CommandId,
  ConcurrencyConflictError,
  CrossProjectionNotFoundError,
  type EventMetadata,
  LocalProjectionNotFoundError,
  makeHandledCommandResponseSchema,
  ProcessorId,
  ProjectionName,
  ProjectionVersion,
} from "@harness/es-contract"
import {
  type AggregateConfig,
  CrossAggregateProjection,
  type HistoricalEvent,
  LocalProjection,
} from "@harness/es-core"
import {
  CartAlreadyCheckedOutError,
  type CartCommand,
  CartCommandV2,
  cartDecider,
  cartDeciderV2,
  CartEvent,
  CartEventV2,
  CartEventV2Codec,
  CartId,
  CartIdMismatchError,
  type CartState,
  CartStateV2,
  CheckoutChannel,
  EmptyCartCheckoutError,
  ItemCount,
} from "@harness/es-core/fixtures/cart"
import { match } from "ts-pattern"
import {
  executeAggregateCommandAndSync,
  queryAggregateReadModel,
  queryCrossAggregateReadModel,
  relayAggregateOutbox,
} from "../../src/index.js"

export const CartStatus = Schema.String.pipe(Schema.brand("CartStatus"))
export type CartStatus = typeof CartStatus.Type

export const TotalQuantity = Schema.Natural.pipe(Schema.brand("TotalQuantity"))
export type TotalQuantity = typeof TotalQuantity.Type

export class CartView extends Schema.Class<CartView>("CartView")({
  cartId: AggregateId,
  itemCount: ItemCount,
  status: CartStatus,
  totalQuantity: TotalQuantity,
}) {}

export class CartViewV2 extends Schema.Class<CartViewV2>("CartViewV2")({
  cartId: AggregateId,
  itemCount: ItemCount,
  status: CartStatus,
  totalQuantity: TotalQuantity,
  checkoutChannel: Schema.optional(CheckoutChannel),
}) {}

interface CartViewRow {
  readonly cart_id: string
  readonly item_count: number
  readonly status: string
  readonly total_quantity: number
}

interface CartViewV2Row {
  readonly cart_id: string
  readonly item_count: number
  readonly status: string
  readonly total_quantity: number
  readonly checkout_channel: string | null
}

export const initCartViewTable: Effect.Effect<void, SqlError, SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`
      CREATE TABLE IF NOT EXISTS projection_cart_view (
        cart_id TEXT PRIMARY KEY NOT NULL,
        item_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        total_quantity INTEGER NOT NULL
      );
    `
})

export const initCartViewV2Table: Effect.Effect<void, SqlError, SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_cart_view_v2 (
        cart_id TEXT PRIMARY KEY NOT NULL,
        item_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        total_quantity INTEGER NOT NULL,
        checkout_channel TEXT
      );
    `
  },
)

export const applyCartView = (
  event: CartEvent,
  metadata: EventMetadata,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const targetAggregateId = metadata.aggregateId
    yield* match(event)
      .with({ _tag: "CartCreated" }, () =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${targetAggregateId}, 0, 'active', 0)
          ON CONFLICT (cart_id) DO NOTHING
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "ItemAdded" }, (e) =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${targetAggregateId}, 1, 'active', ${e.quantity})
          ON CONFLICT (cart_id) DO UPDATE SET
            item_count = item_count + 1,
            total_quantity = total_quantity + ${e.quantity}
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "CartCheckedOut" }, () =>
        sql`
          INSERT INTO projection_cart_view (cart_id, item_count, status, total_quantity)
          VALUES (${targetAggregateId}, 0, 'checked_out', 0)
          ON CONFLICT (cart_id) DO UPDATE SET
            status = 'checked_out'
        `.pipe(Effect.asVoid),
      )
      .exhaustive()
  })

export const applyCartViewV2 = (
  event: CartEventV2,
  metadata: EventMetadata,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const targetAggregateId = metadata.aggregateId
    yield* match(event)
      .with({ _tag: "CartCreated" }, () =>
        sql`
          INSERT INTO projection_cart_view_v2 (cart_id, item_count, status, total_quantity, checkout_channel)
          VALUES (${targetAggregateId}, 0, 'active', 0, NULL)
          ON CONFLICT (cart_id) DO NOTHING
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "ItemAdded" }, (e) =>
        sql`
          INSERT INTO projection_cart_view_v2 (cart_id, item_count, status, total_quantity, checkout_channel)
          VALUES (${targetAggregateId}, 1, 'active', ${e.quantity}, NULL)
          ON CONFLICT (cart_id) DO UPDATE SET
            item_count = item_count + 1,
            total_quantity = total_quantity + ${e.quantity}
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "CartCheckedOut" }, (e) =>
        sql`
          INSERT INTO projection_cart_view_v2 (cart_id, item_count, status, total_quantity, checkout_channel)
          VALUES (${targetAggregateId}, 0, 'checked_out', 0, ${e.channel})
          ON CONFLICT (cart_id) DO UPDATE SET
            status = 'checked_out',
            checkout_channel = ${e.channel}
        `.pipe(Effect.asVoid),
      )
      .exhaustive()
  })

export const queryCartView = (
  aggregateId: AggregateId,
): Effect.Effect<CartView, AggregateNotFoundError | SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<CartViewRow>`
      SELECT cart_id, item_count, status, total_quantity
      FROM projection_cart_view
      WHERE cart_id = ${aggregateId}
    `
    const row = rows[0]
    if (row === undefined) {
      return yield* new AggregateNotFoundError({ aggregateId })
    }
    const cartIdOpt = Schema.decodeOption(AggregateId)(row.cart_id)
    const itemCountOpt = Schema.decodeOption(ItemCount)(row.item_count)
    const statusOpt = Schema.decodeOption(CartStatus)(row.status)
    const totalQuantityOpt = Schema.decodeOption(TotalQuantity)(row.total_quantity)

    const cartId = yield* match(cartIdOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(new Error(`Corrupt cart_id in projection_cart_view: ${row.cart_id}`)),
      )
      .exhaustive()

    const itemCount = yield* match(itemCountOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(
          new Error(`Corrupt item_count in projection_cart_view: ${String(row.item_count)}`),
        ),
      )
      .exhaustive()

    const status = yield* match(statusOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(new Error(`Corrupt status in projection_cart_view: ${row.status}`)),
      )
      .exhaustive()

    const totalQuantity = yield* match(totalQuantityOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(
          new Error(
            `Corrupt total_quantity in projection_cart_view: ${String(row.total_quantity)}`,
          ),
        ),
      )
      .exhaustive()

    return new CartView({
      cartId,
      itemCount,
      status,
      totalQuantity,
    })
  })

export const queryCartViewV2 = (
  aggregateId: AggregateId,
): Effect.Effect<CartViewV2, AggregateNotFoundError | SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<CartViewV2Row>`
      SELECT cart_id, item_count, status, total_quantity, checkout_channel
      FROM projection_cart_view_v2
      WHERE cart_id = ${aggregateId}
    `
    const row = rows[0]
    if (row === undefined) {
      return yield* new AggregateNotFoundError({ aggregateId })
    }

    const cartIdOpt = Schema.decodeOption(AggregateId)(row.cart_id)
    const itemCountOpt = Schema.decodeOption(ItemCount)(row.item_count)
    const statusOpt = Schema.decodeOption(CartStatus)(row.status)
    const totalQuantityOpt = Schema.decodeOption(TotalQuantity)(row.total_quantity)
    const channelRaw = row.checkout_channel === null ? undefined : row.checkout_channel
    const channelOpt = Schema.decodeOption(Schema.UndefinedOr(CheckoutChannel))(channelRaw)

    const cartId = yield* match(cartIdOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(new Error(`Corrupt cart_id in projection_cart_view_v2: ${row.cart_id}`)),
      )
      .exhaustive()

    const itemCount = yield* match(itemCountOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(
          new Error(`Corrupt item_count in projection_cart_view_v2: ${String(row.item_count)}`),
        ),
      )
      .exhaustive()

    const status = yield* match(statusOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(new Error(`Corrupt status in projection_cart_view_v2: ${row.status}`)),
      )
      .exhaustive()

    const totalQuantity = yield* match(totalQuantityOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(
          new Error(
            `Corrupt total_quantity in projection_cart_view_v2: ${String(row.total_quantity)}`,
          ),
        ),
      )
      .exhaustive()

    const checkoutChannel = yield* match(channelOpt)
      .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
      .with({ _tag: "None" }, () =>
        Effect.die(
          new Error(`Corrupt checkout_channel in projection_cart_view_v2: ${String(channelRaw)}`),
        ),
      )
      .exhaustive()

    return new CartViewV2({
      cartId,
      itemCount,
      status,
      totalQuantity,
      checkoutChannel,
    })
  })

export const rebuildCartView = (
  aggregateId: AggregateId,
  events: ReadonlyArray<HistoricalEvent<CartEvent>>,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`DELETE FROM projection_cart_view WHERE cart_id = ${aggregateId}`
    for (const h of events) {
      yield* applyCartView(h.event, h.metadata)
    }
  })

export const rebuildCartViewV2 = (
  aggregateId: AggregateId,
  events: ReadonlyArray<HistoricalEvent<CartEventV2>>,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`DELETE FROM projection_cart_view_v2 WHERE cart_id = ${aggregateId}`
    for (const h of events) {
      yield* applyCartViewV2(h.event, h.metadata)
    }
  })

export const cartViewProjection: LocalProjection<CartEvent, CartView, SqlClient, SqlError> =
  LocalProjection.make({
    name: ProjectionName.make("CartView"),
    version: ProjectionVersion.make(1),
    model: CartView,
    apply: applyCartView,
    query: queryCartView,
    rebuild: rebuildCartView,
  })

export const cartViewProjectionV2: LocalProjection<CartEvent, CartView, SqlClient, SqlError> =
  LocalProjection.make({
    name: ProjectionName.make("CartView"),
    version: ProjectionVersion.make(2),
    model: CartView,
    apply: applyCartView,
    query: queryCartView,
    rebuild: rebuildCartView,
  })

export const cartViewV2Projection: LocalProjection<CartEventV2, CartViewV2, SqlClient, SqlError> =
  LocalProjection.make({
    name: ProjectionName.make("CartView"),
    version: ProjectionVersion.make(2),
    model: CartViewV2,
    apply: applyCartViewV2,
    query: queryCartViewV2,
    rebuild: rebuildCartViewV2,
  })

export const cartAggregateConfig: AggregateConfig<
  CartCommand,
  CartEvent,
  CartState,
  CartAlreadyCheckedOutError | EmptyCartCheckoutError | CartIdMismatchError,
  SqlClient,
  SqlError
> = {
  aggregateName: AggregateName.make("Cart"),
  decider: cartDecider,
  eventSchema: CartEvent,
  projections: [cartViewProjection],
  outboxMode: { _tag: "SuppressOutbox" },
}

export const cartAggregateConfigV2: AggregateConfig<
  CartCommandV2,
  CartEventV2,
  CartStateV2,
  CartAlreadyCheckedOutError | EmptyCartCheckoutError | CartIdMismatchError,
  SqlClient,
  SqlError
> = {
  aggregateName: AggregateName.make("Cart"),
  decider: cartDeciderV2,
  eventSchema: CartEventV2Codec,
  projections: [cartViewV2Projection],
  outboxMode: { _tag: "PublishOutbox" },
}

export class OpenCartSummary extends Schema.Class<OpenCartSummary>("OpenCartSummary")({
  cartId: AggregateId,
  itemCount: ItemCount,
  totalQuantity: TotalQuantity,
  status: CartStatus,
}) {}

export class OpenCartsReport extends Schema.Class<OpenCartsReport>("OpenCartsReport")({
  carts: Schema.Array(OpenCartSummary),
}) {}

export const initOpenCartsProjectionTable: Effect.Effect<void, SqlError, SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_open_carts (
        cart_id TEXT PRIMARY KEY NOT NULL,
        item_count INTEGER NOT NULL,
        total_quantity INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `
  },
)

export const applyOpenCarts = (
  event: CartEvent,
  metadata: EventMetadata,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const targetAggregateId = metadata.aggregateId
    yield* match(event)
      .with({ _tag: "CartCreated" }, () =>
        sql`
          INSERT INTO projection_open_carts (cart_id, item_count, total_quantity, status)
          VALUES (${targetAggregateId}, 0, 0, 'active')
          ON CONFLICT (cart_id) DO NOTHING
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "ItemAdded" }, (e) =>
        sql`
          INSERT INTO projection_open_carts (cart_id, item_count, total_quantity, status)
          VALUES (${targetAggregateId}, 1, ${e.quantity}, 'active')
          ON CONFLICT (cart_id) DO UPDATE SET
            item_count = item_count + 1,
            total_quantity = total_quantity + ${e.quantity}
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "CartCheckedOut" }, () =>
        sql`
          INSERT INTO projection_open_carts (cart_id, item_count, total_quantity, status)
          VALUES (${targetAggregateId}, 0, 0, 'checked_out')
          ON CONFLICT (cart_id) DO UPDATE SET
            status = 'checked_out'
        `.pipe(Effect.asVoid),
      )
      .exhaustive()
  })

export const applyOpenCartsV2 = (
  event: CartEventV2,
  metadata: EventMetadata,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const targetAggregateId = metadata.aggregateId
    yield* match(event)
      .with({ _tag: "CartCreated" }, () =>
        sql`
          INSERT INTO projection_open_carts (cart_id, item_count, total_quantity, status)
          VALUES (${targetAggregateId}, 0, 0, 'active')
          ON CONFLICT (cart_id) DO NOTHING
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "ItemAdded" }, (e) =>
        sql`
          INSERT INTO projection_open_carts (cart_id, item_count, total_quantity, status)
          VALUES (${targetAggregateId}, 1, ${e.quantity}, 'active')
          ON CONFLICT (cart_id) DO UPDATE SET
            item_count = item_count + 1,
            total_quantity = total_quantity + ${e.quantity}
        `.pipe(Effect.asVoid),
      )
      .with({ _tag: "CartCheckedOut" }, () =>
        sql`
          INSERT INTO projection_open_carts (cart_id, item_count, total_quantity, status)
          VALUES (${targetAggregateId}, 0, 0, 'checked_out')
          ON CONFLICT (cart_id) DO UPDATE SET
            status = 'checked_out'
        `.pipe(Effect.asVoid),
      )
      .exhaustive()
  })

export const queryOpenCarts: Effect.Effect<OpenCartsReport, SqlError, SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      cart_id: string
      item_count: number
      total_quantity: number
      status: string
    }>`
      SELECT cart_id, item_count, total_quantity, status
      FROM projection_open_carts
      ORDER BY cart_id ASC
    `
    const carts: Array<OpenCartSummary> = []
    for (const row of rows) {
      const cartIdOpt = Schema.decodeOption(AggregateId)(row.cart_id)
      const itemCountOpt = Schema.decodeOption(ItemCount)(row.item_count)
      const totalQuantityOpt = Schema.decodeOption(TotalQuantity)(row.total_quantity)
      const statusOpt = Schema.decodeOption(CartStatus)(row.status)

      const cartId = yield* match(cartIdOpt)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.die(new Error(`Corrupt cart_id in projection_open_carts: ${row.cart_id}`)),
        )
        .exhaustive()

      const itemCount = yield* match(itemCountOpt)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.die(
            new Error(`Corrupt item_count in projection_open_carts: ${String(row.item_count)}`),
          ),
        )
        .exhaustive()

      const totalQuantity = yield* match(totalQuantityOpt)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.die(
            new Error(
              `Corrupt total_quantity in projection_open_carts: ${String(row.total_quantity)}`,
            ),
          ),
        )
        .exhaustive()

      const status = yield* match(statusOpt)
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.die(new Error(`Corrupt status in projection_open_carts: ${row.status}`)),
        )
        .exhaustive()

      carts.push(new OpenCartSummary({ cartId, itemCount, totalQuantity, status }))
    }
    return new OpenCartsReport({ carts })
  },
)

export const purgeOpenCarts: Effect.Effect<void, SqlError, SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`DELETE FROM projection_open_carts`.pipe(Effect.asVoid)
})

export const openCartsProjection: CrossAggregateProjection<
  CartEvent,
  OpenCartsReport,
  void,
  SqlClient,
  SqlError
> = CrossAggregateProjection.make({
  processorId: ProcessorId.make("open-carts-v1"),
  aggregateName: AggregateName.make("Cart"),
  eventSchema: CartEvent,
  model: OpenCartsReport,
  apply: applyOpenCarts,
  query: () => queryOpenCarts,
  purge: purgeOpenCarts,
})

export const openCartsProjectionV2: CrossAggregateProjection<
  CartEventV2,
  OpenCartsReport,
  void,
  SqlClient,
  SqlError
> = CrossAggregateProjection.make({
  processorId: ProcessorId.make("open-carts-v2"),
  aggregateName: AggregateName.make("Cart"),
  eventSchema: CartEventV2Codec,
  model: OpenCartsReport,
  apply: applyOpenCartsV2,
  query: () => queryOpenCarts,
  purge: purgeOpenCarts,
})

export const cartAggregateWithOutboxConfig: AggregateConfig<
  CartCommand,
  CartEvent,
  CartState,
  CartAlreadyCheckedOutError | EmptyCartCheckoutError | CartIdMismatchError,
  SqlClient,
  SqlError
> = {
  ...cartAggregateConfig,
  projections: [],
  outboxMode: { _tag: "PublishOutbox" },
}

export const CartCommandPayloadV2 = Schema.Struct({
  commandId: CommandId,
  command: CartCommandV2,
})
export type CartCommandPayloadV2 = typeof CartCommandPayloadV2.Type

export const CartCommandResponseV2 = makeHandledCommandResponseSchema(CartStateV2, CartEventV2)
export type CartCommandResponseV2 = typeof CartCommandResponseV2.Type

export const CartApiGroup = HttpApiGroup.make("carts").add(
  HttpApiEndpoint.post("executeCommand", "/carts/:cartId/commands", {
    params: { cartId: AggregateId },
    payload: CartCommandPayloadV2,
    success: CartCommandResponseV2,
    error: [
      CartAlreadyCheckedOutError,
      EmptyCartCheckoutError,
      CartIdMismatchError,
      CommandAggregateMismatchError,
      ConcurrencyConflictError,
    ],
  }),
  HttpApiEndpoint.get("getCartView", "/carts/:cartId", {
    params: { cartId: AggregateId },
    success: CartViewV2,
    error: [AggregateNotFoundError, LocalProjectionNotFoundError],
  }),
  HttpApiEndpoint.get("getOpenCarts", "/reports/open-carts", {
    success: OpenCartsReport,
    error: [CrossProjectionNotFoundError],
  }),
)

export const CartEsApi = HttpApi.make("CartEsApi").add(CartApiGroup)
export type CartEsApi = typeof CartEsApi

export const makeCartApiLayer = HttpApiBuilder.group(CartEsApi, "carts", (handlers) =>
  handlers
    .handle("executeCommand", ({ params, payload }) => {
      const expectedCartId = CartId.make(params.cartId)
      if (payload.command.cartId !== expectedCartId) {
        return Effect.fail(
          new CartIdMismatchError({
            expectedCartId,
            actualCartId: payload.command.cartId,
          }),
        )
      }
      return executeAggregateCommandAndSync(
        params.cartId,
        payload.command,
        payload.commandId,
        cartAggregateConfigV2,
      ).pipe(
        Effect.catchTags({
          EventSerializationError: (err) => Effect.die(err),
          EventStreamCorruptionError: (err) => Effect.die(err),
          SqlError: (err) => Effect.die(err),
        }),
      )
    })
    .handle("getCartView", ({ params }) =>
      queryAggregateReadModel(
        params.cartId,
        ProjectionName.make("CartView"),
        cartAggregateConfigV2,
        [cartViewV2Projection],
      ).pipe(
        Effect.catchTags({
          EventStreamCorruptionError: (err) => Effect.die(err),
          SqlError: (err) => Effect.die(err),
        }),
      ),
    )
    .handle("getOpenCarts", () =>
      Effect.gen(function* () {
        yield* relayAggregateOutbox(AggregateName.make("Cart"), [openCartsProjectionV2])
        return yield* queryCrossAggregateReadModel(ProcessorId.make("open-carts-v2"), undefined, [
          openCartsProjectionV2,
        ])
      }).pipe(
        Effect.catchTags({
          EventSerializationError: (err) => Effect.die(err),
          EventStreamCorruptionError: (err) => Effect.die(err),
          OutboxPublishError: (err) => Effect.die(err),
          ProjectionArchiveCorruptionError: (err) => Effect.die(err),
          SqlError: (err) => Effect.die(err),
        }),
      ),
    ),
)

export const cartEsHttpClientAtom = Atom.make<Layer.Layer<HttpClient.HttpClient>>(
  FetchHttpClient.layer,
)

export class CartEsAtomClient extends AtomHttpApi.Service<CartEsAtomClient>()("CartEsAtomClient", {
  api: CartEsApi,
  httpClient: (get) => get(cartEsHttpClientAtom),
  baseUrl: "http://localhost",
}) {
  static readonly layer = (options: {
    readonly httpClient: Layer.Layer<HttpClient.HttpClient>
    readonly baseUrl?: string | URL | undefined
  }): Layer.Layer<CartEsAtomClient> =>
    Layer.effect(
      CartEsAtomClient,
      HttpApiClient.make(CartEsApi, {
        baseUrl: options.baseUrl ?? "http://localhost",
      }),
    ).pipe(Layer.provide(options.httpClient))
}
