// Idempotent, additive migration: add the `deployedConfigHash` column to the
// `agents` table so the dashboard can detect config drift (current config !=
// the config the live deployment was compiled from) and show a "needs redeploy"
// badge.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-config-drift.mjs

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
      ADD COLUMN IF NOT EXISTS "deployedConfigHash" text
    `)
    await client.query("COMMIT")
    console.log(
      "[migrate-config-drift] OK — agents.deployedConfigHash ensured.",
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
  .catch((err) => {
    console.error("[migrate-config-drift] FAILED:", err)
    pool.end()
    process.exit(1)
  })
