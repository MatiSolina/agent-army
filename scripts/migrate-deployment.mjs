// Idempotent, additive migration: add Eve/Vercel deployment-state columns to
// the `agents` table so each agent can be turned into its own deployed Eve
// Vercel project (its own runtime).
//
// This is NON-DESTRUCTIVE: it only runs `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`. No existing column is ever dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-deployment.mjs

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
      ADD COLUMN IF NOT EXISTS "vercelProjectId" text
    `)
    await client.query(`
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "deploymentUrl" text
    `)
    await client.query(`
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "deploymentStatus" text NOT NULL DEFAULT 'none'
    `)
    await client.query(`
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "lastDeployedAt" timestamp
    `)
    await client.query(`
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "deploymentError" text
    `)

    await client.query("COMMIT")
    console.log(
      "[migrate-deployment] OK — agents deployment columns ensured (vercelProjectId, deploymentUrl, deploymentStatus, lastDeployedAt, deploymentError).",
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
    console.error("[migrate-deployment] FAILED:", err)
    await pool.end()
    process.exit(1)
  })
