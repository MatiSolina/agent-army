// skills.sh fetch helpers. Deliberately NOT in a "use server" file.
//
// In a "use server" module, every `export` becomes a client-callable server
// action. Putting the fetch helpers there would let the client call them
// directly and skip the `requireSessionUser()` gate that the action wrappers
// in `app/actions/skills.ts` enforce — a broken access-control bypass on the
// single-tenant operator gate. Here they're plain server-only helpers,
// callable from the authenticated server actions but not from the client.

const SKILLS_SH_BASE = "https://skills.sh/api/v1"
const MAX_QUERY_CHARS = 120

export type SkillShResult = {
  id: string
  slug: string
  name: string
  source: string
  installs: number
}

type CuratedOrSearchResponse = {
  data?: Array<{
    id?: string
    slug?: string
    name?: string
    source?: string
    installs?: number
    installUrl?: string
    url?: string
  }>
}

// /curated groups skills by owner with a nested `skills[]` array, a different
// shape from /search (flat). Flatten it before normalizing.
type CuratedResponse = {
  data?: Array<{ skills?: CuratedOrSearchResponse["data"] }>
}

function authHeaders(): HeadersInit {
  const token = process.env.VERCEL_OIDC_TOKEN
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function normalizeResults(json: CuratedOrSearchResponse): SkillShResult[] {
  const seen = new Set<string>()
  return (json.data ?? [])
    .filter((r) => r.slug && r.name && r.source)
    .map((r) => ({
      id: r.id ?? `${r.source}/${r.slug}`,
      slug: r.slug as string,
      name: r.name as string,
      source: r.source as string,
      installs: typeof r.installs === "number" ? r.installs : 0,
    }))
    // skills.sh can return the same skill twice (e.g. curated + search overlap);
    // dedupe so React keys stay unique and we don't show duplicate rows.
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
}

// Degrade to [] on any failure (401, 5xx, network). A server action that throws
// turns into a 500 and breaks the rendering Server Component (the Capabilities
// tab goes blank in prod with a generic 'Server Components render' error);
// returning [] keeps the action — and the tab — alive when skills.sh is down.
export async function fetchCuratedSkillsSh(): Promise<SkillShResult[]> {
  try {
    const res = await fetch(`${SKILLS_SH_BASE}/skills/curated`, {
      headers: authHeaders(),
      cache: "no-store",
    })
    if (!res.ok) return []
    const json = (await res.json()) as CuratedResponse
    const flat = (json.data ?? []).flatMap((group) => group.skills ?? [])
    return normalizeResults({ data: flat })
  } catch {
    return []
  }
}

export async function fetchSearchSkillsSh(query: string): Promise<SkillShResult[]> {
  const q = query.trim().slice(0, MAX_QUERY_CHARS)
  if (!q) return []
  try {
    const res = await fetch(
      `${SKILLS_SH_BASE}/skills/search?q=${encodeURIComponent(q)}&limit=20`,
      { headers: authHeaders(), cache: "no-store" },
    )
    if (!res.ok) return []
    return normalizeResults((await res.json()) as CuratedOrSearchResponse)
  } catch {
    return []
  }
}

