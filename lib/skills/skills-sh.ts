// skills.sh fetch helpers. Deliberately NOT in a "use server" file.
//
// In a "use server" module, every `export` becomes a client-callable server
// action. Putting the fetch helpers there would let the client call them
// directly and skip the `requireSessionUser()` gate that the action wrappers
// in `app/actions/skills.ts` enforce — a broken access-control bypass on the
// single-tenant operator gate. Here they're plain server-only helpers,
// callable from the authenticated server actions but not from the client.

import { randomUUID } from "@/lib/uid"
import { getOidcToken } from "@/lib/skills/oidc-token"

const SKILLS_SH_BASE = "https://skills.sh/api/v1"
const MAX_QUERY_CHARS = 120
const MAX_PATH_CHARS = 200
const MAX_CONTENT_CHARS = 200_000

export type SkillShResult = {
  id: string
  slug: string
  name: string
  source: string
  installs: number
}

// An imported skill, or null when skills.sh is unreachable / the skill is
// malformed. Same degrade-to-null contract as fetchCuratedSkillsSh: a "use
// server" action that throws turns into a 500 and surfaces in prod as a
// generic 'Server Components render' error, blanking the Capabilities tab.
export type AgentSkillDraft = {
  id: string
  name: string
  description: string
  content: string
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

async function authHeaders(): Promise<HeadersInit> {
  const token = await getOidcToken()
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
      headers: await authHeaders(),
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
      { headers: await authHeaders(), cache: "no-store" },
    )
    if (!res.ok) return []
    return normalizeResults((await res.json()) as CuratedOrSearchResponse)
  } catch {
    return []
  }
}

type SkillDetailResponse = {
  files?: Array<{ path?: string; contents?: string }>
}

/**
 * Minimal `---\nkey: value\n---` frontmatter parser. SKILL.md frontmatter we
 * care about (name, description) is flat key/value, so a line-based parser
 * avoids a YAML dep. Returns the parsed keys plus the body after the fence.
 */
function parseFrontmatter(raw: string): {
  data: Record<string, string>
  body: string
} {
  const normalized = raw.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { data: {}, body: normalized.trim() }

  const data: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key) continue
    let val = line.slice(idx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    data[key] = val
  }
  const body = normalized.slice(match[0].length).trim()
  return { data, body }
}

export function parseSkillMarkdown(raw: string): AgentSkillDraft | null {
  const { data, body } = parseFrontmatter(raw)
  const name = (data.name ?? "").trim()
  if (!name) return null
  return {
    id: randomUUID(),
    name,
    description: (data.description ?? "").trim(),
    content: body.slice(0, MAX_CONTENT_CHARS),
  }
}

// Fetch a skill's detail, locate its SKILL.md, parse it and return a draft
// ready to merge into local state. Returns null (never throws) on any failure:
// network, non-2xx, missing SKILL.md, or SKILL.md with no `name` frontmatter.
export async function fetchSkillDetailSh(
  source: string,
  slug: string,
): Promise<AgentSkillDraft | null> {
  const safeSource = source.trim().slice(0, MAX_PATH_CHARS)
  const safeSlug = slug.trim().slice(0, MAX_PATH_CHARS)
  if (!safeSource || !safeSlug) return null
  // `source` is a multi-segment path (e.g. "anthropics/skills"); encode each
  // segment but keep the slashes so the API routes it correctly.
  const sourcePath = safeSource
    .split("/")
    .map(encodeURIComponent)
    .join("/")
  try {
    const res = await fetch(
      `${SKILLS_SH_BASE}/skills/${sourcePath}/${encodeURIComponent(safeSlug)}`,
      { headers: await authHeaders(), cache: "no-store" },
    )
    if (!res.ok) return null
    const json = (await res.json()) as SkillDetailResponse
    const files = json.files ?? []
    const skillFile = files.find((f) =>
      (f.path ?? "").toLowerCase().endsWith("skill.md"),
    )
    if (!skillFile?.contents) return null
    return parseSkillMarkdown(skillFile.contents)
  } catch {
    return null
  }
}

