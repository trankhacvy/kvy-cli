import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` reads this to diff src/db/schema.ts against
// "one dialect — the whole point"). `DATABASE_URL` here is only used by
// `drizzle-kit` introspection/push commands, not by `generate`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://kvy:kvy@localhost:5432/kvy",
  },
});
