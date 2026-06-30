// Idempotent, additive migration: add the `slackConnectUid` column to the
// `channels` table. It stores the Vercel Connect connector UID (e.g.
// "slack/soporte") for a Slack-type channel: the agent's Slack app identity.
// Kapso channels leave it null. The `type` column already exists (default
// 'kapso') and is the channel discriminator.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-slack-channel.mjs

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
      ALTER TABLE "channels"
      ADD COLUMN IF NOT EXISTS "slackConnectUid" text
    `)
    await client.query("COMMIT")
    console.log("[migrate-slack-channel] OK — channels.slackConnectUid ensured.")
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
    console.error("[migrate-slack-channel] FAILED:", err)
    pool.end()
    process.exit(1)
  })
