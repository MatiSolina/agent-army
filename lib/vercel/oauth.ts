/**
 * Vercel OAuth helpers.
 *
 * SECURITY: token exchange is server-side only. These helpers MUST never include
 * the raw response (which carries the access token) in thrown errors or logs.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Generate a CSPRNG anti-CSRF `state` for the Vercel install flow. The value is
 * put in the install URL (?state=...) and mirrored back to /api/vercel/callback;
 * the same value is stored in an httpOnly cookie so the callback can verify it.
 * base64url so it is safe in a query string and a cookie value.
 */
export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Constant-time compare of the `state` returned by Vercel against the value we
 * stored in the cookie. Returns false (never throws) on null/empty inputs or a
 * length mismatch — timingSafeEqual requires equal-length buffers.
 */
export function safeCompareState(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * PURE. Parse the JSON body of the Vercel token-exchange response
 * (POST https://api.vercel.com/v2/oauth/access_token) into our internal shape.
 *
 * Reads snake_case keys: access_token, team_id, installation_id, scope.
 * Defensive: non-object input, or a missing/empty/non-string access_token, throws
 * a fixed error. The raw json is NEVER included in the error (no secret leak).
 * Absent team_id / installation_id / scope (or non-string values) become null.
 */
export function parseAccessTokenResponse(json: unknown): {
  accessToken: string
  teamId: string | null
  installationId: string | null
  scope: string | null
} {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("Vercel token exchange returned no access_token")
  }

  const obj = json as Record<string, unknown>

  if (typeof obj.access_token !== "string" || obj.access_token === "") {
    throw new Error("Vercel token exchange returned no access_token")
  }

  const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

  return {
    accessToken: obj.access_token,
    teamId: str(obj.team_id),
    installationId: str(obj.installation_id),
    scope: str(obj.scope),
  }
}

const VERCEL_TOKEN_ENDPOINT = "https://api.vercel.com/v2/oauth/access_token"

/** The parsed shape returned by a successful token exchange. */
export type VercelTokenExchangeResult = ReturnType<
  typeof parseAccessTokenResponse
>

export type ExchangeCodeParams = {
  code: string
  redirectUri: string
  clientId: string
  clientSecret: string
  // Injectable for tests; defaults to the global fetch in production.
  fetchImpl?: typeof fetch
}

/**
 * Exchange a single-use Vercel authorization `code` for an access token.
 *
 * POSTs application/x-www-form-urlencoded { client_id, client_secret, code,
 * redirect_uri } to https://api.vercel.com/v2/oauth/access_token and parses the
 * JSON response via parseAccessTokenResponse.
 *
 * SECURITY: SERVER-SIDE ONLY. The client_secret and the raw response body
 * (which carries the access token) MUST never appear in a thrown error or log.
 * On a non-2xx response we throw a fixed message that does not echo the body,
 * the status, or any credential.
 */
export async function exchangeCodeForToken(
  params: ExchangeCodeParams,
): Promise<VercelTokenExchangeResult> {
  const { code, redirectUri, clientId, clientSecret } = params
  const doFetch = params.fetchImpl ?? fetch

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  })

  const res = await doFetch(VERCEL_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })

  if (!res.ok) {
    // Do NOT read/echo the body — it may reflect credentials. Fixed message.
    throw new Error("Vercel token exchange failed")
  }

  const json: unknown = await res.json()
  // parseAccessTokenResponse throws a sanitized error if access_token is absent.
  return parseAccessTokenResponse(json)
}
