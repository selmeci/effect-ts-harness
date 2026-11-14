# D1 Repositories with Native `@effect/sql-d1`

D1 database repositories use native Effect v4 SQL (`@effect/sql-d1` + `SqlClient.SqlClient`) in `type:infra`, decoding database rows into `type:contract` `Schema` instances. **`drizzle-orm` and `drizzle-kit` are banned across the workspace.**

## Native `@effect/sql-d1` on Cloudflare D1

In this codebase, D1 interactions use `D1Client.layer({ db })` from `@effect/sql-d1` and `SqlClient.SqlClient` from `effect/unstable/sql` (or `@effect/sql`). All SQL queries and driver imports are strictly confined to `type:infra`.

## Repository Implementation and Schema Decoding

Repositories must use parameterized `sql\`...\`` tagged template queries (never string-interpolated SQL) and decode raw SQL rows into domain contract `Schema` instances. SQL/driver types must never escape into `type:domain` or `apps/web`:

```ts
// libs/sample/infra/src/photo-repository.ts
import { Effect, Layer, Schema } from "effect"
import { D1Client } from "@effect/sql-d1"
import { SqlClient } from "effect/unstable/sql"
import { PhotoId, PhotoSchema } from "@sample/contract/photos"
import { PhotoRepo, PhotoNotFoundError } from "@sample/service/photo-repository"

export const makeD1ClientLayer = (db: D1Database) => D1Client.layer({ db })

export const PhotoRepoLive = Layer.effect(
  PhotoRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const findById = Effect.fn("PhotoRepo.findById")(function* (id: PhotoId) {
      const rows = yield* sql`
        SELECT id, title, url, view_count AS viewCount, created_at AS createdAt
        FROM photos
        WHERE id = ${id}
        LIMIT 1
      `
      if (rows.length === 0) {
        return yield* new PhotoNotFoundError({ id })
      }
      // Decode raw SQL row into type:contract Schema
      return yield* Schema.decodeUnknownEffect(PhotoSchema)(rows[0])
    })

    return PhotoRepo.of({ findById })
  }),
)
```

## Migrations Workflow

1. **Hand-Authored Versioned `.sql` Migrations**:
   - Write forward SQL migrations ahead of time into versioned `.sql` files under `migrations/` (e.g. `migrations/0001_initial.sql`).
   - Migrations must be committed to git. `drizzle-kit` is banned and must never be used.
2. **Never Generate at Deploy**:
   - Migrations are never generated dynamically during deployment.
3. **Validation & Escalation Rules (`pnpm harness check-migrations`)**:
   - Validate all `.sql` migrations with `pnpm harness check-migrations` (backed by `MigrationSafety.decide`).
   - Any migration containing `DROP TABLE`, `DROP COLUMN`, SQLite table rebuilds (`__new_` / `PRAGMA foreign_keys=OFF`), or `ALTER TABLE ADD COLUMN ... NOT NULL` without `DEFAULT` is flagged (`unsafe-sql-migration`) and must escalate to the human for approval.
