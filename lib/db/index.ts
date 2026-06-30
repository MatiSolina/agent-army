import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema"
import { SUPABASE_CA } from "./supabase-ca"

const connectionString = process.env.DATABASE_URL

// Supabase poolers require TLS. Local Postgres does not.
const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString)

// TLS is VERIFIED against Supabase's pinned root CA (rejectUnauthorized: true).
// The pooler presents a Supabase-issued chain not in Node's default bundle, so we
// pin the public "Supabase Root 2021 CA" rather than disabling verification.
export const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { ca: SUPABASE_CA, rejectUnauthorized: true },
})

export const db = drizzle(pool, { schema })
