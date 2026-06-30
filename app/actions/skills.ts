"use server"

import { unzipSync, strFromU8 } from "fflate"
import type { AgentSkill } from "@/lib/db/schema"
import { requireSessionUser } from "@/lib/session"
import {
  fetchCuratedSkillsSh,
  fetchSearchSkillsSh,
  fetchSkillDetailSh,
  parseSkillMarkdown,
  type SkillShResult,
} from "@/lib/skills/skills-sh"

// ----- skills.sh integration -----
//
// These server actions wrap the skills.sh API so the bearer token
// (VERCEL_OIDC_TOKEN) never reaches the client and we sidestep CORS.
// They return clean data the Skills editor can drop straight into local state.
// The fetch helpers live in `lib/skills/skills-sh.ts` (NOT a "use server"
// file) so they can't be invoked as server actions directly, which would
// bypass the requireSessionUser() gate enforced here.

export type { SkillShResult } from "@/lib/skills/skills-sh"

const MAX_ZIP_BYTES = 5 * 1024 * 1024 // 5 MB is plenty for a SKILL.md bundle
const MAX_QUERY_CHARS = 120

export async function getCuratedSkillsSh(): Promise<SkillShResult[]> {
  await requireSessionUser()
  return fetchCuratedSkillsSh()
}

export async function searchSkillsSh(query: string): Promise<SkillShResult[]> {
  await requireSessionUser()
  const q = query.trim().slice(0, MAX_QUERY_CHARS)
  if (!q) return getCuratedSkillsSh()
  return fetchSearchSkillsSh(query)
}

/**
 * Import a skill from skills.sh. Returns the parsed skill, or null when the
 * fetch fails, the skill is missing a SKILL.md, or the SKILL.md has no `name`.
 * Returns null (never throws) so a down/unreachable skills.sh surfaces as a
 * tame "could not import" toast instead of a 500 / 'Server Components render'.
 */
export async function importSkillFromSh(
  source: string,
  slug: string,
): Promise<AgentSkill | null> {
  await requireSessionUser()
  return fetchSkillDetailSh(source, slug)
}

/**
 * Accept an uploaded .zip (as a FormData with a `file` field), unzip it in
 * memory, find SKILL.md (root or any subfolder), parse it and return an
 * AgentSkill. Returns null (never throws) on any failure.
 */
export async function importSkillFromZip(
  formData: FormData,
): Promise<AgentSkill | null> {
  await requireSessionUser()
  const file = formData.get("file")
  if (!(file instanceof File)) return null
  if (file.size === 0) return null
  if (file.size > MAX_ZIP_BYTES) return null

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    return null
  }

  // Prefer a root SKILL.md, fall back to the shallowest match in a subfolder.
  const candidates = Object.keys(entries)
    .filter((p) => p.toLowerCase().endsWith("skill.md") && !p.endsWith("/"))
    .sort((a, b) => a.split("/").length - b.split("/").length)

  const skillPath = candidates[0]
  if (!skillPath) return null

  return parseSkillMarkdown(strFromU8(entries[skillPath]))
}
