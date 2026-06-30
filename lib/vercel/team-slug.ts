/**
 * Reads the Vercel team slug used to build dashboard deep-links.
 *
 * Single-tenant: one fixed team, configured via the VERCEL_TEAM_SLUG env var
 * (the team's URL slug, e.g. the `acme` in vercel.com/acme/...). This is NOT
 * the same as VERCEL_TEAM_ID (an opaque id) — the dashboard URL needs the slug.
 *
 * Returns the trimmed value, or null when unset/blank (the deep-link is simply
 * hidden when null). Never expose this value to the client — only the finished
 * URL string built from it.
 */
export function getVercelTeamSlug(): string | null {
  return process.env.VERCEL_TEAM_SLUG?.trim() || null
}
