/**
 * Vercel token + team resolution for the REST API client.
 *
 * PRODUCTION: connect Vercel via OAuth (stored in app_settings under key
 * 'vercel_oauth'), or set VERCEL_TOKEN (required) and, optionally,
 * VERCEL_TEAM_ID. The CLI auth.json fallback below is a local-dev convenience
 * only; serverless runtimes do not have a home directory with a Vercel CLI
 * installation, so that path is never reached in production.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { appSettings } from "@/lib/db/schema"

const VERCEL_OAUTH_KEY = "vercel_oauth"

/**
 * The shape stored in app_settings under key 'vercel_oauth'. Single-tenant.
 * SECURITY: the accessToken never leaves the server.
 */
export type StoredVercelOAuth = {
  accessToken: string
  teamId: string | null
  installationId: string | null
  scope: string | null
}

/**
 * Read the stored Vercel OAuth result from app_settings (key 'vercel_oauth').
 * Returns the minimal {accessToken, teamId} the resolver needs, or null when
 * absent / malformed. Defensive: a non-string accessToken yields null.
 *
 * SECURITY: the token is never logged.
 */
export async function getStoredVercelOAuth(): Promise<{
  accessToken: string
  teamId: string | null
} | null> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, VERCEL_OAUTH_KEY))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const value = row.value as Record<string, unknown>
  const accessToken = value?.accessToken
  if (typeof accessToken !== "string" || accessToken === "") return null

  const teamId = typeof value.teamId === "string" ? value.teamId : null
  return { accessToken, teamId }
}

/**
 * Upsert the Vercel OAuth result into app_settings under key 'vercel_oauth'
 * (onConflictDoUpdate). value jsonb = { accessToken, teamId, installationId,
 * scope }. Single-tenant — there is exactly one row.
 *
 * SECURITY: token exchange is server-side only; this writer is server-side
 * only and never logs the token.
 */
export async function setStoredVercelOAuth(
  data: StoredVercelOAuth,
): Promise<void> {
  const value = {
    accessToken: data.accessToken,
    teamId: data.teamId,
    installationId: data.installationId,
    scope: data.scope,
  }
  await db
    .insert(appSettings)
    .values({ key: VERCEL_OAUTH_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    })
}

/**
 * PURE. Given the parsed contents of the Vercel CLI auth file
 * (~/Library/Application Support/com.vercel.cli/auth.json), return the
 * `token` string if present and non-empty, else null.
 * Defensive: non-object inputs → null.
 */
export function parseCliAuthToken(json: unknown): string | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return null
  }
  const obj = json as Record<string, unknown>
  if (typeof obj.token !== "string" || obj.token === "") {
    return null
  }
  return obj.token
}

/**
 * LOCAL DEV FALLBACK reader. Read the Vercel CLI auth.json from the user's home
 * directory and return its token, or null on any failure (missing/unreadable/
 * invalid JSON). Never throws. Injected via deps in tests so the suite stays
 * hermetic.
 */
async function readCliAuthTokenFromDisk(): Promise<string | null> {
  const authFilePath = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.vercel.cli",
    "auth.json",
  )
  try {
    const raw = await fs.readFile(authFilePath, "utf-8")
    const parsed: unknown = JSON.parse(raw)
    return parseCliAuthToken(parsed)
  } catch {
    return null
  }
}

/**
 * Injectable dependencies for resolveVercelAuth. Mirrors how client.ts injects
 * `fetchImpl` — production omits these and the real readers are used; tests pass
 * stubs so no DB / env / filesystem is touched.
 */
export type ResolveVercelAuthDeps = {
  // Stored OAuth reader (defaults to getStoredVercelOAuth).
  getStoredOAuth?: () => Promise<{
    accessToken: string
    teamId: string | null
  } | null>
  // Env getter (defaults to reading process.env).
  getEnv?: (key: string) => string | undefined
  // CLI auth.json token reader (defaults to reading disk).
  readCliAuthToken?: () => Promise<string | null>
}

/**
 * Resolve the Vercel token and optional team ID for the REST client.
 *
 * Resolution order:
 *   1. Stored OAuth (app_settings 'vercel_oauth') — the Connect-Vercel path.
 *   2. VERCEL_TOKEN env var (backward-compat, required in older serverless).
 *   3. LOCAL DEV FALLBACK: the Vercel CLI auth.json from the user's home dir.
 *   4. If none yields a token, throws an actionable error.
 *
 * SECURITY: the token is never logged or included in any thrown error.
 */
export async function resolveVercelAuth(
  deps: ResolveVercelAuthDeps = {},
): Promise<{
  token: string
  teamId?: string
}> {
  const getStoredOAuth = deps.getStoredOAuth ?? getStoredVercelOAuth
  const getEnv = deps.getEnv ?? ((key: string) => process.env[key])
  const readCliAuthToken = deps.readCliAuthToken ?? readCliAuthTokenFromDisk

  // 1. Stored OAuth wins.
  const stored = await getStoredOAuth()
  if (stored && stored.accessToken.trim() !== "") {
    return { token: stored.accessToken, teamId: stored.teamId ?? undefined }
  }

  // 2. Env var (backward compat).
  const envToken = getEnv("VERCEL_TOKEN")
  const teamId = getEnv("VERCEL_TEAM_ID") || undefined
  if (envToken && envToken.trim() !== "") {
    return { token: envToken, teamId }
  }

  // 3. LOCAL DEV FALLBACK — never reached in production (no CLI auth file there).
  const cliToken = await readCliAuthToken()
  if (cliToken) {
    return { token: cliToken, teamId }
  }

  // 4. Nothing.
  throw new Error("No Vercel token available (set VERCEL_TOKEN)")
}
