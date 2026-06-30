"use server"

import { db } from "@/lib/db"
import { agents, channels } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import { getConnections } from "@/lib/mcp/get-connections"
import { projectName } from "@/lib/eve/project"
import { expectedEnvKeys } from "@/lib/eve/env-spec"
import { listProjectEnvKeys } from "@/lib/vercel/client"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import { and, eq } from "drizzle-orm"

/**
 * Per-agent secrets, read against the agent's OWN Vercel project.
 *
 * Secret VALUES are injected at deploy time (see buildAgentEnvSpec); this module
 * only reads back MASKED keys to render status. It never returns or logs a
 * secret value, and no value is ever sent to the browser.
 *
 * Single-tenant: all reads are scoped after the Supabase Auth access gate.
 */

/** Load + authorize an agent row, returning its safe Vercel project slug. */
async function loadAgentSlug(agentId: string): Promise<{
  agent: typeof agents.$inferSelect
  slug: string
}> {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
  const agent = rows[0]
  if (!agent) throw new Error("Agent not found")
  const slug = projectName(agent)
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    throw new Error("Could not derive a safe project name")
  }
  return { agent, slug }
}

/**
 * Compute the set of env keys this agent is EXPECTED to have configured, from
 * its assigned token connections (<SLUG>_TOKEN) plus its assigned Kapso channel
 * (KAPSO_*). Used to render each key's "configured" status.
 */
async function expectedKeysForAgent(
  agent: typeof agents.$inferSelect,
): Promise<string[]> {
  const userId = await requireUserId()
  const connections = await getConnections()
  const assignedChannels = await db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agent.id), eq(channels.userId, userId)))

  // Single source of truth for "what keys this agent can have" — gates token
  // connections on token-auth so OAuth/none connections don't render a phantom
  // <SLUG>_TOKEN field. Mirrors exactly what buildAgentEnvSpec pushes.
  return expectedEnvKeys({
    agent,
    connections,
    channelType: assignedChannels[0]?.type ?? null,
  })
}

/**
 * Report which of the agent's EXPECTED env keys are currently configured on its
 * Vercel project. Returns keys + booleans ONLY — never any value.
 */
export async function getAgentSecretStatus(
  agentId: string,
): Promise<{ key: string; configured: boolean }[]> {
  // Tolerant of a missing agent: this runs concurrently with the page's own
  // getAgent()/notFound() guard, so a not-found agent must not throw here.
  let loaded: { agent: typeof agents.$inferSelect; slug: string }
  try {
    loaded = await loadAgentSlug(agentId)
  } catch {
    return []
  }
  const { agent, slug } = loaded
  const expected = await expectedKeysForAgent(agent)
  if (expected.length === 0) return []

  let presentKeys: Set<string>
  try {
    const { token, teamId } = await resolveVercelAuth()
    const onProject = await listProjectEnvKeys({ token, teamId }, slug)
    presentKeys = new Set(onProject.map((e) => e.key))
  } catch {
    // No Vercel auth / project not reachable → show everything as not set
    // rather than failing the page render.
    presentKeys = new Set()
  }

  return expected.map((key) => ({ key, configured: presentKeys.has(key) }))
}
