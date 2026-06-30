import { defineConfig } from "drizzle-kit"
import { config } from "dotenv"
config({ path: ".env.local" })

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  // Migrations run over the session pooler (5432); DDL fails on the transaction pooler (6543).
  dbCredentials: { url: process.env.DIRECT_URL! },
  verbose: true,
  strict: true,
})
