// Idempotent, additive migration: introduce global `tools` and `connections`
// (MCP) tables and add `toolIds` / `connectionIds` id-arrays to `agents`.
//
// This is NON-DESTRUCTIVE: the legacy inline `agents.tools` / `agents.connections`
// jsonb columns are left in place (no DROP). New global tables start empty.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-tools-mcp.mjs

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
      CREATE TABLE IF NOT EXISTS tools (
        "id" text PRIMARY KEY,
        "userId" text NOT NULL,
        "name" text NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "inputSchema" text NOT NULL DEFAULT '',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS connections (
        "id" text PRIMARY KEY,
        "userId" text NOT NULL,
        "name" text NOT NULL,
        "transport" text NOT NULL DEFAULT 'http',
        "url" text NOT NULL DEFAULT '',
        "token" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `)

    await client.query(`
      ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS "toolIds" jsonb NOT NULL DEFAULT '[]'::jsonb
    `)

    await client.query(`
      ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS "connectionIds" jsonb NOT NULL DEFAULT '[]'::jsonb
    `)

    await client.query("COMMIT")
    console.log("[migrate-tools-mcp] OK — tables tools/connections ensured; agents.toolIds/connectionIds ensured.")
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
    console.error("[migrate-tools-mcp] FAILED:", err)
    await pool.end()
    process.exit(1)
  })
