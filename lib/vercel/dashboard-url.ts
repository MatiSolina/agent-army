/**
 * Builds Vercel dashboard deep-link URLs for a single deployed agent project.
 *
 * Pure: no env reads, no fetch, no Date.now() — the caller supplies `teamSlug`
 * (from the VERCEL_TEAM_SLUG env var; never expose it to the client, only the
 * finished URL strings) and `projectName` (derived via projectName(agent)).
 *
 * Both segments are passed through encodeURIComponent. This is defence in depth:
 * `projectName` already matches `^[a-z0-9-]+$`, but encoding both segments
 * guarantees a stray `/`, space, or `..` can never break out of the intended
 * path and point the link somewhere else.
 */
export function buildVercelDashboardUrls(args: {
  teamSlug: string
  projectName: string
}): { project: string; observability: string; logs: string } {
  const team = encodeURIComponent(args.teamSlug)
  const project = encodeURIComponent(args.projectName)
  const base = `https://vercel.com/${team}/${project}`

  return {
    project: base,
    observability: `${base}/observability`,
    logs: `${base}/logs`,
  }
}
