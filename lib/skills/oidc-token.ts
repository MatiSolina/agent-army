// Vercel OIDC token helper for the skills.sh channel.
//
// skills.sh authenticates with a Vercel OIDC Bearer token. In production Vercel
// injects it as process.env.VERCEL_OIDC_TOKEN at runtime; locally it is NOT in
// the env, so reading the env var directly leaves local dev unable to reach
// skills.sh (every call 401s). The @vercel/oidc helper resolves a token via the
// linked Vercel CLI and refreshes it when it rotates (~12h), so local dev works
// without `vercel env pull` on every change.
//
// Must be called inside the request handler, never hoisted to module scope: the
// token is request-scoped and rotates. Falls back to the env var when the helper
// can't run (CI / containers without a linked CLI), so prod and CI keep working.

import { getVercelOidcToken } from "@vercel/oidc"

export async function getOidcToken(): Promise<string | null> {
  try {
    return await getVercelOidcToken()
  } catch {
    return process.env.VERCEL_OIDC_TOKEN ?? null
  }
}
