"use server"

import { unzipSync, strFromU8 } from "fflate"
import { randomUUID } from "crypto"
import type { AgentSkill } from "@/lib/db/schema"
import { requireSessionUser } from "@/lib/session"

// ----- skills.sh integration -----
//
// These server actions wrap the skills.sh API so the bearer token
// (VERCEL_OIDC_TOKEN) never reaches the client and we sidestep CORS.
// They return clean data the Skills editor can drop straight into local state.

const SKILLS_SH_BASE = "https://skills.sh/api/v1"
const MAX_ZIP_BYTES = 5 * 1024 * 1024 // 5 MB is plenty for a SKILL.md bundle
const MAX_CONTENT_CHARS = 200_000
const MAX_QUERY_CHARS = 120
const MAX_PATH_CHARS = 200

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

type SkillDetailResponse = {
  files?: Array<{ path?: string; contents?: string }>
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

/**
 * Minimal `---\nkey: value\n---` frontmatter parser. Avoids a heavy YAML dep:
 * SKILL.md frontmatter we care about (name, description) is flat key/value, so
 * a line-based parser is enough. Returns the parsed keys plus the body that
 * follows the closing fence.
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
    // Strip surrounding quotes if present.
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

/** Build an AgentSkill from a SKILL.md file's raw contents. */
function skillFromMarkdown(raw: string): AgentSkill | null {
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

// /curated groups skills by owner with a nested `skills[]` array, a different
// shape from /search (flat). Flatten it before normalizing.
type CuratedResponse = {
  data?: Array<{ skills?: CuratedOrSearchResponse["data"] }>
}

export async function getCuratedSkillsSh(): Promise<SkillShResult[]> {
  await requireSessionUser()
  const res = await fetch(`${SKILLS_SH_BASE}/skills/curated`, {
    headers: authHeaders(),
    cache: "no-store",
  })
  if (!res.ok) {
    throw new Error(`skills.sh responded ${res.status}`)
  }
  const json = (await res.json()) as CuratedResponse
  const flat = (json.data ?? []).flatMap((group) => group.skills ?? [])
  return normalizeResults({ data: flat })
}

export async function searchSkillsSh(query: string): Promise<SkillShResult[]> {
  await requireSessionUser()
  const q = query.trim().slice(0, MAX_QUERY_CHARS)
  if (!q) return getCuratedSkillsSh()
  const res = await fetch(
    `${SKILLS_SH_BASE}/skills/search?q=${encodeURIComponent(q)}&limit=20`,
    { headers: authHeaders(), cache: "no-store" },
  )
  if (!res.ok) {
    throw new Error(`skills.sh responded ${res.status}`)
  }
  return normalizeResults((await res.json()) as CuratedOrSearchResponse)
}

/**
 * Fetch a skill's detail, locate its SKILL.md, parse it and return an
 * AgentSkill ready to merge into local state. Does NOT persist anything.
 */
export async function importSkillFromSh(
  source: string,
  slug: string,
): Promise<AgentSkill> {
  await requireSessionUser()
  const safeSource = source.trim().slice(0, MAX_PATH_CHARS)
  const safeSlug = slug.trim().slice(0, MAX_PATH_CHARS)
  if (!safeSource || !safeSlug) {
    throw new Error("Missing skill source or slug")
  }
  // `source` is a multi-segment path (e.g. "anthropics/skills"); encode each
  // segment but keep the slashes so the API routes it correctly.
  const sourcePath = safeSource
    .split("/")
    .map(encodeURIComponent)
    .join("/")
  const res = await fetch(
    `${SKILLS_SH_BASE}/skills/${sourcePath}/${encodeURIComponent(safeSlug)}`,
    { headers: authHeaders(), cache: "no-store" },
  )
  if (!res.ok) {
    throw new Error(`Could not fetch the skill (${res.status})`)
  }
  const json = (await res.json()) as SkillDetailResponse
  const files = json.files ?? []
  const skillFile = files.find((f) =>
    (f.path ?? "").toLowerCase().endsWith("skill.md"),
  )
  if (!skillFile?.contents) {
    throw new Error("The skill does not contain a SKILL.md file")
  }
  const skill = skillFromMarkdown(skillFile.contents)
  if (!skill) {
    throw new Error("SKILL.md is missing a 'name' field in its frontmatter")
  }
  return skill
}

/**
 * Accept an uploaded .zip (as a FormData with a `file` field), unzip it in
 * memory, find SKILL.md (root or any subfolder), parse it and return an
 * AgentSkill. Does NOT persist anything.
 */
export async function importSkillFromZip(
  formData: FormData,
): Promise<AgentSkill> {
  await requireSessionUser()
  const file = formData.get("file")
  if (!(file instanceof File)) {
    throw new Error("No file was received")
  }
  if (file.size === 0) {
    throw new Error("The file is empty")
  }
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error("The .zip exceeds the 5 MB limit")
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new Error("Could not decompress the .zip")
  }

  // Prefer a root SKILL.md, fall back to the shallowest match in a subfolder.
  const candidates = Object.keys(entries)
    .filter((p) => p.toLowerCase().endsWith("skill.md") && !p.endsWith("/"))
    .sort((a, b) => a.split("/").length - b.split("/").length)

  const skillPath = candidates[0]
  if (!skillPath) {
    throw new Error("The .zip does not contain a SKILL.md file")
  }

  const skill = skillFromMarkdown(strFromU8(entries[skillPath]))
  if (!skill) {
    throw new Error("SKILL.md is missing a 'name' field in its frontmatter")
  }
  return skill
}
