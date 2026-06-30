// Idempotent, additive migration: create the `app_settings` key/value table so
// app-wide structured config (e.g. the Vercel OAuth connection result under key
// 'vercel_oauth') can be persisted in Neon.
//
// This is NON-DESTRUCTIVE: it only runs `CREATE TABLE IF NOT EXISTS`. No
// existing table or column is ever dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-vercel-auth.mjs

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
      CREATE TABLE IF NOT EXISTS "app_settings" (
        "key" text PRIMARY KEY,
        "value" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `)

    await client.query("COMMIT")
    console.log(
      "[migrate-vercel-auth] OK — app_settings table ensured (key, value, updatedAt).",
    )
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("[migrate-vercel-auth] FAILED:", err)
    await pool.end()
    process.exit(1)
  })
