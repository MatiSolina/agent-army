// Idempotent, additive migration: add the Discord columns to the `channels`
// table. They store the three static secrets pushed to the agent's Vercel
// project env (discordBotToken -> DISCORD_BOT_TOKEN, discordApplicationId ->
// DISCORD_APPLICATION_ID, discordPublicKey -> DISCORD_PUBLIC_KEY). Unlike
// Telegram there is NO non-secret username analog; unlike Slack none are
// Connect-brokered; none are auto-minted (the public key is issued by the
// Discord Developer Portal). Kapso/Slack/Telegram channels leave them null. The
// `type` column already exists (default 'kapso') and is the channel discriminator.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-discord-channel.mjs

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
      ADD COLUMN IF NOT EXISTS "discordBotToken" text
    `)
    await client.query(`
      ALTER TABLE "channels"
      ADD COLUMN IF NOT EXISTS "discordApplicationId" text
    `)
    await client.query(`
      ALTER TABLE "channels"
      ADD COLUMN IF NOT EXISTS "discordPublicKey" text
    `)
    await client.query("COMMIT")
    console.log("[migrate-discord-channel] OK — channels Discord columns ensured.")
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
    console.error("[migrate-discord-channel] FAILED:", err)
    pool.end()
    process.exit(1)
  })
