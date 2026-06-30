// Idempotent, additive migration: create the `fleet_updates` table that tracks
// a fleet-update workflow run so the dashboard can poll its status (no
// list-runs API in the Workflow DevKit → persist the runId in our own table).
//
// NON-DESTRUCTIVE: only `CREATE TABLE IF NOT EXISTS`. No existing table or
// column is dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-fleet-updates.mjs

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
      CREATE TABLE IF NOT EXISTS "fleet_updates" (
        "id" text PRIMARY KEY,
        "runId" text,
        "mode" text NOT NULL,
        "target" text NOT NULL,
        "aiPin" text NOT NULL,
        "canaryAgentId" text,
        "status" text NOT NULL DEFAULT 'running',
        "result" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `)

    await client.query("COMMIT")
    console.log("fleet_updates ready")
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("migration failed:", err)
    process.exit(1)
  })
