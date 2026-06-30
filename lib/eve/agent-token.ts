import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Per-agent M2M credential. The Fleet Manager holds ONE secret FM_AGENT_KEY and
 * derives each agent's token as HMAC-SHA256(FM_AGENT_KEY, agentId). The token is
 * baked into that agent's Vercel env (EVE_AGENT_TOKEN); on every agent->FM
 * callback the FM recomputes the HMAC for the claimed agent id and compares, so a
 * token mathematically authorizes exactly one agent id — no per-agent secret is
 * stored and no DB migration is needed.
 *
 * agentId is NOT secret; the HMAC is the authorizer. FM_AGENT_KEY never leaves
 * the FM (env-spec.ts refuses to bake it), so leaking one agent's env exposes
 * only that agent's own credential.
 */
export function agentToken(agentId: string, fmKey: string): string {
  return createHmac("sha256", fmKey).update(agentId).digest("base64url")
}

/** Timing-safe verify that `presented` is the token for `agentId`. */
export function verifyAgentToken(
  agentId: string,
  presented: string | null | undefined,
  fmKey: string | undefined,
): boolean {
  if (!presented || !fmKey) return false
  const expected = Buffer.from(agentToken(agentId, fmKey))
  const got = Buffer.from(presented)
  // timingSafeEqual requires equal lengths; the length check short-circuits
  // before it, and base64url HMAC output is fixed-length so this is not a leak.
  return expected.length === got.length && timingSafeEqual(expected, got)
}
