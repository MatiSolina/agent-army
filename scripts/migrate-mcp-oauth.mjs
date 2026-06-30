// Idempotent, additive migration: add OAuth 2.1 columns to the `connections`
// table so OAuth MCP servers (Linear, GitHub, Notion, Sentry, Stripe, ...) can
// be connected via the authorization-code + PKCE flow.
//
// This is NON-DESTRUCTIVE: it only runs `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`. The existing `token` column (used by `auth: "token"` servers) is
// left untouched. No column is ever dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-mcp-oauth.mjs

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
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'idle'
    `)
    await client.query(`
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "oauthClientInfo" jsonb
    `)
    await client.query(`
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "oauthServerInfo" jsonb
    `)
    await client.query(`
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "oauthTokens" jsonb
    `)
    await client.query(`
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "oauthCodeVerifier" text
    `)
    await client.query(`
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "oauthState" text
    `)
    await client.query(`
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "oauthScope" text
    `)
    await client.query(`
      ALTER TABLE "connections"
      ADD COLUMN IF NOT EXISTS "oauthError" text
    `)

    await client.query("COMMIT")
    console.log(
      "[migrate-mcp-oauth] OK — connections OAuth columns ensured (status, oauthClientInfo, oauthServerInfo, oauthTokens, oauthCodeVerifier, oauthState, oauthScope, oauthError).",
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
    console.error("[migrate-mcp-oauth] FAILED:", err)
    await pool.end()
    process.exit(1)
  })
