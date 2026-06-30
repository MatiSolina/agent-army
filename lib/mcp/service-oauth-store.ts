import { db } from "@/lib/db"
import { connections } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { DEMO_USER_ID } from "@/lib/session"
import type { OAuthStore, OAuthRecord } from "./oauth-store"

/**
 * Session-free (machine-to-machine) `OAuthStore` backed by Drizzle.
 *
 * Identical to {@link DbOAuthStore} except it scopes by the constant
 * single-operator owner (`DEMO_USER_ID`) instead of calling `requireUserId()`.
 * The token broker endpoint (`/api/mcp/token`) is M2M, authenticated by a
 * shared secret rather than an operator session, so it cannot use the session-bound
 * `DbOAuthStore` (whose `requireUserId()` throws "Unauthorized" with no session).
 *
 * Every read and write is still scoped by BOTH the connection id AND the
 * single-tenant owner. Tokens stay in the database; they never appear in any
 * redirect, query string, or response body.
 */
export class ServiceOAuthStore implements OAuthStore {
  async load(connectionId: string): Promise<OAuthRecord | null> {
    const rows = await db
      .select({
        oauthClientInfo: connections.oauthClientInfo,
        oauthServerInfo: connections.oauthServerInfo,
        oauthTokens: connections.oauthTokens,
        oauthCodeVerifier: connections.oauthCodeVerifier,
        oauthState: connections.oauthState,
        oauthScope: connections.oauthScope,
      })
      .from(connections)
      .where(
        and(eq(connections.id, connectionId), eq(connections.userId, DEMO_USER_ID)),
      )
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return {
      oauthClientInfo: row.oauthClientInfo ?? null,
      oauthServerInfo: row.oauthServerInfo ?? null,
      oauthTokens: row.oauthTokens ?? null,
      oauthCodeVerifier: row.oauthCodeVerifier ?? null,
      oauthState: row.oauthState ?? null,
      oauthScope: row.oauthScope ?? null,
    }
  }

  async patch(
    connectionId: string,
    fields: Partial<OAuthRecord>,
  ): Promise<void> {
    const now = new Date()
    // Stamp token issuance time only when tokens are written (see db-oauth-store).
    const tokenStamp =
      fields.oauthTokens !== undefined ? { oauthTokensUpdatedAt: now } : {}
    await db
      .update(connections)
      .set({ ...fields, ...tokenStamp, updatedAt: now })
      .where(
        and(eq(connections.id, connectionId), eq(connections.userId, DEMO_USER_ID)),
      )
  }
}
