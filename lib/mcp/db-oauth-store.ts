import { db } from "@/lib/db"
import { connections } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { requireUserId } from "@/lib/session"
import type { OAuthStore, OAuthRecord } from "./oauth-store"

/**
 * Production `OAuthStore` backed by Drizzle. Every read and write is scoped by
 * BOTH the connection id AND the signed-in single-tenant workspace user. Tokens
 * and all OAuth artifacts stay in the database; they never appear in any
 * redirect, query string, or response body.
 *
 * This runs inside route handlers, so it does NOT call `revalidatePath`.
 */
export class DbOAuthStore implements OAuthStore {
  async load(connectionId: string): Promise<OAuthRecord | null> {
    const userId = await requireUserId()
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
      .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)))
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
    const userId = await requireUserId()
    const now = new Date()
    // Stamp token issuance time only when the tokens themselves are written, so
    // expiry is derived from when the tokens were minted (not unrelated edits).
    const tokenStamp =
      fields.oauthTokens !== undefined ? { oauthTokensUpdatedAt: now } : {}
    // Only the keys present in `fields` are written.
    await db
      .update(connections)
      .set({ ...fields, ...tokenStamp, updatedAt: now })
      .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)))
  }
}
