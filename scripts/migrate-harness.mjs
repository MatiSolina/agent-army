// Idempotent, additive migration: add the `harness` column to the `agents`
// table. It stores which built-in eve tools (bash / file tools / web fetch /
// web search) the deployed agent keeps. Default `{}` = full default harness, so
// existing agents are unaffected.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-harness.mjs

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
      ADD COLUMN IF NOT EXISTS "harness" jsonb NOT NULL DEFAULT '{}'::jsonb
    `)
    await client.query("COMMIT")
    console.log("[migrate-harness] OK — agents.harness ensured.")
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
    console.error("[migrate-harness] FAILED:", err)
    pool.end()
    process.exit(1)
  })
