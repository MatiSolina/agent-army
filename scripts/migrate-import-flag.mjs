// Idempotent, additive migration: add the `imported` flag to the `agents` table.
// True for agents brought in via the "Import deployed agent" flow — they are
// linked to a Vercel deployment agent-army did NOT create, so the dashboard
// restricts them to prompt updates and never tears down their Vercel project on
// delete. Default false = a normally-created agent (full management), so existing
// rows are unaffected.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-import-flag.mjs

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
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "imported" boolean NOT NULL DEFAULT false
    `)
    await client.query("COMMIT")
    console.log("[migrate-import-flag] OK — agents.imported ensured.")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[migrate-import-flag] FAILED:", err)
    pool.end()
    process.exit(1)
  })
