// Idempotent, additive migration: add the Telegram columns to the `channels`
// table. They store the static secrets pushed to the agent's Vercel project env
// (telegramBotToken -> TELEGRAM_BOT_TOKEN, telegramWebhookSecretToken ->
// TELEGRAM_WEBHOOK_SECRET_TOKEN) plus the non-secret telegramBotUsername.
// Kapso/Slack channels leave them null. The `type` column already exists
// (default 'kapso') and is the channel discriminator.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-telegram-channel.mjs

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
      ADD COLUMN IF NOT EXISTS "telegramBotToken" text
    `)
    await client.query(`
      ALTER TABLE "channels"
      ADD COLUMN IF NOT EXISTS "telegramWebhookSecretToken" text
    `)
    await client.query(`
      ALTER TABLE "channels"
      ADD COLUMN IF NOT EXISTS "telegramBotUsername" text
    `)
    await client.query("COMMIT")
    console.log("[migrate-telegram-channel] OK — channels Telegram columns ensured.")
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
    console.error("[migrate-telegram-channel] FAILED:", err)
    pool.end()
    process.exit(1)
  })
