import { defineConfig } from "drizzle-kit"
import { config } from "dotenv"
config({ path: ".env.local" })

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  // migraciones via session pooler (5432); DDL no corre bien por el transaction pooler (6543)
  dbCredentials: { url: process.env.DIRECT_URL! },
  verbose: true,
  strict: true,
})
