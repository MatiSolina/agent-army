// Migration: change the `spans` primary key from (spanId) to (traceId, spanId).
//
// Why: OTel span ids are unique only WITHIN a trace, so a single-column spanId PK
// could drop a genuinely distinct span that happens to share an id across traces
// (the ingest dedupes via ON CONFLICT on the PK).
//
// Safe-ish: drops the old single-column PK and adds the composite PK. If two rows
// somehow share (traceId, spanId) the ADD will fail, so dedupe first (the DELETE
// below keeps the earliest createdAt). spans is observability data, so this is
// low-risk; back up first if you care about historical spans.
//
// Run with:
//   node --env-file=.env.local scripts/migrate-spans-pk.mjs

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
    // Collapse any pre-existing (traceId, spanId) duplicates before the composite
    // PK is added (keep the earliest-ingested row).
    await client.query(`
      DELETE FROM "spans" a
      USING "spans" b
      WHERE a."traceId" = b."traceId"
        AND a."spanId" = b."spanId"
        AND a."createdAt" > b."createdAt"
    `)
    // Drop whatever single-column PK exists, then add the composite one. The
    // constraint name is the drizzle/pg default ("spans_pkey").
    await client.query(`ALTER TABLE "spans" DROP CONSTRAINT IF EXISTS "spans_pkey"`)
    await client.query(
      `ALTER TABLE "spans" ADD CONSTRAINT "spans_pkey" PRIMARY KEY ("traceId", "spanId")`,
    )
    await client.query("COMMIT")
    console.log("[migrate-spans-pk] OK — spans PK is now (traceId, spanId).")
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
    console.error("[migrate-spans-pk] FAILED:", err)
    pool.end()
    process.exit(1)
  })
