# D1 Repositories with Drizzle ORM

D1 database repositories use drizzle-orm/effect-d1 on @effect/sql-d1 in type:infra, decoding database rows into contract Schemas.

## Drizzle ORM on Cloudflare D1

In this codebase, D1 interactions use `drizzle-orm/effect-d1` (`1.0.0-rc.5-ab785fc`) powered by `@effect/sql-d1`. All table declarations and database queries are strictly confined to `type:infra`.

## Table Definitions in `type:infra`

Define tables using Drizzle's `sqliteTable`:

```ts
// libs/sample/infra/src/schema/photos.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const photosTable = sqliteTable("photos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  viewCount: integer("view_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})
```

## Repository Implementation and Schema Decoding

Repositories must decode raw SQL/Drizzle rows into domain contract `Schema` instances. Drizzle types must never escape into `type:domain` or `apps/web`:

```ts
// libs/sample/infra/src/photo-repository.ts
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/effect-d1"
import { PhotoSchema } from "contract/photos"
import { PhotoRepo, PhotoNotFoundError } from "service/photo-repository"
import { photosTable } from "./schema/photos.js"

export const PhotoRepoLive = Layer.effect(
  PhotoRepo,
  Effect.gen(function* () {
    const db = yield* DrizzleD1Client

    const findById = Effect.fn("PhotoRepo.findById")(function* (id: string) {
      const rows = yield* db.select().from(photosTable).where(eq(photosTable.id, id))
      if (rows.length === 0) {
        return yield* new PhotoNotFoundError({ id })
      }
      // Decode Drizzle row into type:contract Schema
      return yield* Schema.decodeUnknownEffect(PhotoSchema)(rows[0])
    })

    return PhotoRepo.of({ findById })
  }),
)
```

## Migrations Workflow

1. **Generation**:
   - Migrations are generated ahead of time using `drizzle-kit generate` into versioned subfolders (e.g. `migrations/0001_initial.sql`).
   - Migrations must be committed to git.
2. **Never Generate at Deploy**:
   - Migrations are never generated dynamically during deployment.
3. **Escalation Rules**:
   - Any migration containing a `DROP TABLE`, `DROP COLUMN`, or table rebuild is considered a destructive change and must escalate to the human for approval.
