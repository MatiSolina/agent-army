import { db } from "@/lib/db"
import { connections } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { DEMO_USER_ID } from "@/lib/session"
import { ServiceOAuthStore } from "./service-oauth-store"
import { assertPublicHttpUrl } from "./ssrf-guard"
import type { OAuthStore } from "./oauth-store"
import type { OAuthTokens } from "@ai-sdk/mcp"

/**
 * Resolve a currently-valid OAuth access token for an MCP connection, for the
 * Fleet Manager token broker (`/api/mcp/token`). The OAuth flow is self-hosted
 * here: consent happens once in the FM UI; this helper keeps the access token
 * fresh server-side by refreshing it against the authorization server's token
 * endpoint when it has expired (or is about to).
 *
 * Server-only. Returns the live access token (and, when known, its absolute
 * expiry). Throws when there is no usable token so the route can map it to a
 * 409 "needs reconnect". NEVER logs any token value.
 *
 * Why a hand-rolled refresh instead of the SDK's `auth()`: `auth()` performs
 * network discovery on every call before refreshing, which is costly in the
 * broker hot-path and harder to test. We already have the token endpoint cached
 * in `oauthServerInfo`, so we do the `grant_type=refresh_token` POST directly
 * and persist via the same `store.patch({ oauthTokens })` write the SDK's
 * `saveTokens` uses.
 */
export async function getFreshAccessToken(
  connectionId: string,
  deps: {
    store?: OAuthStore
    now?: () => number
    fetchFn?: typeof fetch
    /**
     * Test-only override of the token issuance time (epoch ms). In production
     * this is read from `connections.updatedAt` (set on every `saveTokens`).
     */
    issuedAt?: number
  } = {},
): Promise<{ token: string; expiresAt?: number }> {
  const store = deps.store ?? new ServiceOAuthStore()
  const now = deps.now ?? (() => Date.now())
  const fetchFn = deps.fetchFn ?? fetch

  const rec = await store.load(connectionId)
  if (!rec || !rec.oauthTokens?.access_token) {
    throw new Error("no token: needs reconnect")
  }

  const tokens = rec.oauthTokens

  // Issuance time: OAuthTokens stores only a RELATIVE `expires_in`, so the
  // absolute expiry is derived from the dedicated `oauthTokensUpdatedAt` stamp
  // (written atomically with the tokens). Tests inject `issuedAt`. NO fallback
  // to the row-wide updatedAt — that gets bumped by unrelated edits and would
  // skew expiry.
  const issuedAt = deps.issuedAt ?? (await loadIssuedAt(connectionId))

  const MARGIN_MS = 60_000

  if (tokens.expires_in == null) {
    // No declared lifetime → treat as non-expiring; return as-is.
    return { token: tokens.access_token }
  }

  // We know the token's lifetime. If we don't know when it was issued (no stamp),
  // we can't trust it's still valid → fall through to refresh rather than risk
  // handing back a stale token.
  if (issuedAt != null) {
    const expiresAt = issuedAt + tokens.expires_in * 1000
    if (expiresAt - now() > MARGIN_MS) {
      return { token: tokens.access_token, expiresAt }
    }
  }

  // Expired / about to expire. We need a refresh token to recover.
  if (!tokens.refresh_token) {
    throw new Error("expired: needs reconnect")
  }

  const endpoint = rec.oauthServerInfo?.tokenEndpoint
  if (!endpoint) {
    throw new Error("no token endpoint: needs reconnect")
  }
  // SSRF guard: the token endpoint comes from AS discovery — reject internal /
  // non-https targets before POSTing the refresh token (and client secret) to it.
  await assertPublicHttpUrl(endpoint)

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  })
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  }
  const clientId = rec.oauthClientInfo?.client_id
  const clientSecret = rec.oauthClientInfo?.client_secret
  if (clientId && clientSecret) {
    headers["Authorization"] =
      "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  } else if (clientId) {
    params.set("client_id", clientId)
  }

  const res = await fetchFn(endpoint, {
    method: "POST",
    headers,
    body: params,
  })
  if (!res.ok) {
    // Do NOT include the AS response body (never log/echo tokens or errors).
    throw new Error(`refresh failed ${res.status}`)
  }
  const json = (await res.json()) as Partial<OAuthTokens>
  if (!json.access_token) {
    throw new Error("refresh failed: no access_token")
  }

  const next: OAuthTokens = {
    access_token: json.access_token,
    token_type: json.token_type ?? tokens.token_type ?? "bearer",
    ...(json.expires_in != null ? { expires_in: json.expires_in } : {}),
    ...(json.scope ? { scope: json.scope } : {}),
    // Preserve the old refresh token when the AS does not rotate one.
    refresh_token: json.refresh_token ?? tokens.refresh_token,
  }

  // Same write the SDK's DbOAuthClientProvider.saveTokens performs; patch()
  // bumps updatedAt, so the recomputed expiry below uses `now()` as issuance.
  await store.patch(connectionId, { oauthTokens: next })

  const newExpiresAt =
    next.expires_in != null ? now() + next.expires_in * 1000 : undefined
  return newExpiresAt != null
    ? { token: next.access_token, expiresAt: newExpiresAt }
    : { token: next.access_token }
}

/**
 * Read the token issuance time from the dedicated oauthTokensUpdatedAt stamp
 * (written atomically with the tokens). Returns undefined when unstamped — the
 * caller then refreshes rather than trusting an unknown-age token.
 */
async function loadIssuedAt(connectionId: string): Promise<number | undefined> {
  const rows = await db
    .select({ oauthTokensUpdatedAt: connections.oauthTokensUpdatedAt })
    .from(connections)
    .where(
      and(eq(connections.id, connectionId), eq(connections.userId, DEMO_USER_ID)),
    )
    .limit(1)
  const issued = rows[0]?.oauthTokensUpdatedAt
  return issued ? issued.getTime() : undefined
}
