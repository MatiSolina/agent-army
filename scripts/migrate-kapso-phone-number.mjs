// Idempotent, additive migration: add the `kapsoPhoneNumber` column to the
// `channels` table. It stores the non-secret display phone number (e.g.
// "+1 205-840-7113") captured from the number picker, used for the UI label and
// a wa.me deep link. The existing `kapsoPhoneNumberId` is the Meta
// phone_number_id (not a dialable number), so the human number lives separately.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-kapso-phone-number.mjs

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
      ADD COLUMN IF NOT EXISTS "kapsoPhoneNumber" text
    `)
    await client.query("COMMIT")
    console.log("[migrate-kapso-phone-number] OK — channels.kapsoPhoneNumber ensured.")
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
    console.error("[migrate-kapso-phone-number] FAILED:", err)
    pool.end()
    process.exit(1)
  })
