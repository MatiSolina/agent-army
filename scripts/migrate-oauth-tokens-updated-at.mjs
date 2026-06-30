// Idempotent, additive migration: add connections.oauthTokensUpdatedAt.
//
// Holds the absolute issuance time of the stored OAuth tokens, used by the token
// broker to derive expiry from the tokens' relative expires_in. Previously the
// row-wide updatedAt was used, but unrelated edits bump it and skew the expiry.
//
// NON-DESTRUCTIVE: only `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Existing rows
// get NULL and the broker falls back to updatedAt until the next token write.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-oauth-tokens-updated-at.mjs

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
    await client.query(
      `ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "oauthTokensUpdatedAt" timestamp`,
    )
    await client.query("COMMIT")
    console.log("[migrate-oauth-tokens-updated-at] OK — connections.oauthTokensUpdatedAt ensured.")
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
    console.error("[migrate-oauth-tokens-updated-at] FAILED:", err)
    pool.end()
    process.exit(1)
  })
