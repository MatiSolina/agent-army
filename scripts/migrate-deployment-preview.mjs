// Idempotent, additive migration: add preview-deploy columns to the `agents`
// table so each agent can ship a Vercel PREVIEW deployment (testable in the web
// chat) before the user explicitly promotes it to production.
//
// This is NON-DESTRUCTIVE: it only runs `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`. No existing column is ever dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-deployment-preview.mjs

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
      ADD COLUMN IF NOT EXISTS "previewUrl" text
    `)
    await client.query(`
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "previewDeploymentId" text
    `)

    await client.query("COMMIT")
    console.log(
      "[migrate-deployment-preview] OK — agents preview columns ensured (previewUrl, previewDeploymentId).",
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
    console.error("[migrate-deployment-preview] FAILED:", err)
    await pool.end()
    process.exit(1)
  })
