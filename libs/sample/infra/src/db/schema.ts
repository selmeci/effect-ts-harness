import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const photos = sqliteTable("photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  albumId: text("album_id").notNull(),
  createdAt: integer("created_at").notNull(),
})

export const albumCounters = sqliteTable("album_counters", {
  albumId: text("album_id").primaryKey(),
  count: integer("count").notNull(),
})
