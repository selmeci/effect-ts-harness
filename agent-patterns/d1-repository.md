# D1 Repositories with Native `@effect/sql-d1`

D1 database repositories use native Effect v4 SQL (`@effect/sql-d1` + `SqlClient.SqlClient`) in `type:infra`, decoding database rows into `type:contract` `Schema` instances. **`drizzle-orm` and `drizzle-kit` are banned across the workspace.**

## Native `@effect/sql-d1` on Cloudflare D1

In this codebase, D1 interactions use `D1Client.layer({ db })` from `@effect/sql-d1/D1Client` and `SqlClient` from `effect/sql/SqlClient`. All SQL queries and driver imports are strictly confined to `type:infra`.

## Repository Implementation and Schema Decoding

Repositories must use parameterized `sql\`...\`` tagged template queries (never string-interpolated SQL) and decode raw SQL rows into domain contract `Schema` instances. SQL/driver types must never escape into `type:domain` or `apps/sample-web`:

```ts
// libs/sample/infra/src/index.ts
import { Effect, Layer, Schema } from "effect"
import * as D1Client from "@effect/sql-d1/D1Client"
import { SqlClient } from "effect/sql/SqlClient"
import {
  Photo,
  type PhotoId,
  PhotoNotFoundError,
  PhotoStorageError,
  StorageErrorMessage,
  StorageOperationName,
} from "@harness/sample-contract"
import { PhotoRepo } from "@harness/sample-service"

export type D1DatabaseBinding = D1Client.D1ClientConfig["db"]

const toPhotoStorageError = (operation: string, err: unknown): PhotoStorageError =>
  new PhotoStorageError({
    operation: StorageOperationName.make(operation),
    message: StorageErrorMessage.make(err instanceof Error ? err.message : String(err)),
  })

export const makePhotoRepoSql = (sql: SqlClient): PhotoRepo["Service"] => {
  const findById = Effect.fn("PhotoRepo.findById")(function* (id: PhotoId) {
    const rows = yield* sql`
      SELECT id, name, album_id AS albumId, created_at AS createdAt
      FROM photos
      WHERE id = ${id}
    `.pipe(Effect.mapError((err) => toPhotoStorageError("PhotoRepo.findById", err)))
    const firstRow = rows[0]
    if (firstRow === undefined) {
      return yield* new PhotoNotFoundError({ id })
    }
    // Decode raw SQL row into type:contract Schema
    return yield* Schema.decodeUnknownEffect(Photo)(firstRow).pipe(
      Effect.mapError((err) => toPhotoStorageError("PhotoRepo.findById", err)),
    )
  })

  // ... insert, listAll (also check `rows[0] === undefined` on RETURNING and map errors via `toPhotoStorageError`)
  return PhotoRepo.of({ insert, findById, listAll })
}

export const PhotoRepoD1Layer: Layer.Layer<PhotoRepo, never, SqlClient> = Layer.effect(
  PhotoRepo,
  Effect.map(SqlClient, makePhotoRepoSql),
)
```

## Migrations Workflow

1. **Hand-Authored Versioned `.sql` Migrations**:
   - Write forward SQL migrations ahead of time into versioned `.sql` files under `migrations/` (e.g. `libs/sample/infra/migrations/0001_photos_and_counters.sql`).
   - Migrations must be committed to git. `drizzle-kit` is banned and must never be used.
2. **Never Generate at Deploy**:
   - Migrations are never generated dynamically during deployment.
3. **Validation & Escalation Rules (`pnpm harness check-migrations`)**:
   - Validate all `.sql` migrations with `pnpm harness check-migrations` (backed by `MigrationSafety.decide`).
   - Any migration containing `DROP TABLE`, `DROP COLUMN`, SQLite table rebuilds (`__new_` / `PRAGMA foreign_keys=OFF`), or `ALTER TABLE ADD COLUMN ... NOT NULL` without `DEFAULT` is flagged (`unsafe-sql-migration`) and must escalate to the human for approval.
