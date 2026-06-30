import type { Connection } from "@/lib/db/schema"

/**
 * The connection shape that is safe to ship to the browser (RSC payload / HTML).
 *
 * It deliberately OMITS every secret server-side artifact: the static bearer
 * `token`, live OAuth `oauthTokens` (access + refresh), the PKCE
 * `oauthCodeVerifier`, the CSRF `oauthState`, and the DCR `oauthClientInfo` /
 * `oauthServerInfo`. None of these may ever be serialized into a client
 * component prop. The static token is reduced to a boolean (`hasToken`) so the
 * UI can still render a "has token" badge without exposing the secret itself.
 */
export type ClientConnection = {
  id: string
  name: string
  transport: string
  url: string
  status: string
  oauthError: string | null
  oauthScope: string | null
  hasToken: boolean
  createdAt: Date
}

/**
 * Project a full server-side `Connection` row down to the browser-safe
 * `ClientConnection`. This is the single chokepoint that guarantees no token
 * or OAuth secret crosses the server/client boundary.
 */
export function toClientConnection(row: Connection): ClientConnection {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    status: row.status,
    oauthError: row.oauthError,
    oauthScope: row.oauthScope,
    hasToken: Boolean(row.token),
    createdAt: row.createdAt,
  }
}
