// Idempotent, additive migration: create the `rate_limits` table used by the
// Postgres-backed fixed-window rate limiter (lib/rate-limit.ts).
//
// NON-DESTRUCTIVE: only `CREATE TABLE IF NOT EXISTS`. No existing table or
// column is dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-rate-limits.mjs

import pg from "pg"

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (use --env-file=.env.local)")
  }

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`
      CREATE TABLE IF NOT EXISTS "rate_limits" (
        "key" text PRIMARY KEY,
        "count" integer NOT NULL DEFAULT 0,
        "windowStart" timestamp NOT NULL DEFAULT now()
      )
    `)
    await client.query("COMMIT")
    console.log("rate_limits table ready")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
