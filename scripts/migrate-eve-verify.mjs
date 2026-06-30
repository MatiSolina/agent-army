// Idempotent, additive migration: add the gated eve-bump preview-test verdict
// columns to the `agents` table. `eveVerifiedVersion` records the gated eve
// version an agent verified OK in a pinned preview deploy (un-gates the Update
// for that agent); `eveVerifyError` records the raw error from the last FAILED
// preview-test (feeds the copy-paste handoff prompt). They are mutually
// exclusive and both cleared on any config change.
//
// This is NON-DESTRUCTIVE: it only runs `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`. No existing column is ever dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-eve-verify.mjs

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
      ADD COLUMN IF NOT EXISTS "eveVerifiedVersion" text
    `)
    await client.query(`
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "eveVerifyError" text
    `)

    await client.query("COMMIT")
    console.log(
      "[migrate-eve-verify] OK — agents eve-verify columns ensured (eveVerifiedVersion, eveVerifyError).",
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
    console.error("[migrate-eve-verify] FAILED:", err)
    await pool.end()
    process.exit(1)
  })
