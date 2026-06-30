// Idempotent, additive migration: create the `spans` table that stores OTel
// spans ingested from a Vercel Trace Drain (app/api/drains/traces).
//
// NON-DESTRUCTIVE: only `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
// EXISTS`. No existing table or column is dropped or altered.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-spans.mjs

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
      CREATE TABLE IF NOT EXISTS "spans" (
        "spanId" text PRIMARY KEY,
        "traceId" text NOT NULL,
        "userId" text NOT NULL,
        "agentId" text,
        "vercelProjectId" text,
        "serviceName" text,
        "name" text NOT NULL,
        "model" text,
        "inputTokens" integer,
        "outputTokens" integer,
        "durationMs" integer NOT NULL DEFAULT 0,
        "startTime" timestamp NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `)

    // Hot paths: per-user newest-first listing, and per-agent lookups.
    await client.query(`
      CREATE INDEX IF NOT EXISTS "spans_userId_startTime_idx"
      ON "spans" ("userId", "startTime" DESC)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS "spans_agentId_idx"
      ON "spans" ("agentId")
    `)

    await client.query("COMMIT")
    console.log("✓ spans table ready")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
