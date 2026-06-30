// Idempotent, additive migration: add the `deployedConfig` jsonb column to the
// `agents` table so the deploy confirm dialog can diff the current config
// against the snapshot the live deployment was built from.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-deployed-config.mjs

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
      ADD COLUMN IF NOT EXISTS "deployedConfig" jsonb
    `)
    await client.query("COMMIT")
    console.log("[migrate-deployed-config] OK — agents.deployedConfig ensured.")
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
    console.error("[migrate-deployed-config] FAILED:", err)
    pool.end()
    process.exit(1)
  })
