import type {
  OAuthClientInformation,
  OAuthAuthorizationServerInformation,
  OAuthTokens,
} from "@ai-sdk/mcp"

/**
 * The OAuth artifacts persisted per connection. Mirrors the OAuth columns on
 * the `connections` table. DB nulls are represented as `null` here.
 */
export interface OAuthRecord {
  oauthClientInfo: OAuthClientInformation | null
  oauthServerInfo: OAuthAuthorizationServerInformation | null
  oauthTokens: OAuthTokens | null
  oauthCodeVerifier: string | null
  oauthState: string | null
  oauthScope: string | null
}

/**
 * Narrow async key-value contract scoped per connection id. This is the only
 * thing the OAuth client provider depends on, which keeps the provider pure
 * and unit-testable: tests inject an in-memory implementation, production
 * injects a Drizzle-backed one (see `db-oauth-store.ts`).
 */
export interface OAuthStore {
  /** Load the OAuth record for a connection, or null if it does not exist. */
  load(connectionId: string): Promise<OAuthRecord | null>
  /** Patch only the provided fields of a connection's OAuth record. */
  patch(connectionId: string, fields: Partial<OAuthRecord>): Promise<void>
}
