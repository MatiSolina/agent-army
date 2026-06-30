"use server"

import { db } from "@/lib/db"
import { agents, channels } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import { deleteProject } from "@/lib/vercel/client"
import { projectName } from "@/lib/eve/project"
import { agentSlug } from "@/lib/slug"
import { AGENT_TEMPLATES, agentRowFromTemplate } from "@/lib/templates"
import { DEFAULT_INSTRUCTIONS, LIMITS } from "@/lib/defaults"
import {
  boundedText,
  boundedBody,
  boundedInt,
  modelId,
  normalizeAgentConfigInput,
  type AgentConfigInput,
} from "@/lib/agent-normalize"
import {
  toClientChannel,
  type ClientChannel,
} from "@/lib/channels/client-channel"
import { and, desc, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { randomUUID } from "crypto"

function normalizeAgentInput(input: AgentInput) {
  const systemPrompt =
    boundedBody(input.systemPrompt, LIMITS.systemPrompt).trim() ||
    DEFAULT_INSTRUCTIONS
  return {
    name: boundedText(input.name, LIMITS.agentName) || "Untitled agent",
    description: boundedText(input.description, LIMITS.agentDescription),
    model: modelId(input.model),
    systemPrompt,
    temperature: boundedInt(input.temperature, 0, 100, 70),
  }
}

export async function getAgents() {
  const userId = await requireUserId()
  return db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(desc(agents.createdAt))
}

export async function getAgent(id: string) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.userId, userId)))
  return rows[0] ?? null
}

// Resolve the detail-page URL param, which is now a name slug. Falls back to an
// exact id match so old /agents/<uuid> links and the post-create redirect still
// land. First slug match wins (names aren't unique).
export async function getAgentBySlug(slug: string) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
  return rows.find((a) => agentSlug(a.name) === slug) ?? rows.find((a) => a.id === slug) ?? null
}

// Channels assigned to a given agent (for the agent detail page).
export async function getAgentChannels(agentId: string) {
  const userId = await requireUserId()
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agentId), eq(channels.userId, userId)))
}

export async function getAgentChannelsForClient(
  agentId: string,
): Promise<ClientChannel[]> {
  const rows = await getAgentChannels(agentId)
  return rows.map(toClientChannel)
}

// ----- create / quick fields -----

// All optional: "From scratch" creates a bare agent with no input at all
// (createAgent({})). The editor fills the rest.
export type AgentInput = {
  name?: string
  description?: string
  model?: string
  systemPrompt?: string
  temperature?: number
}

export async function createAgent(input: AgentInput) {
  const userId = await requireUserId()
  const next = normalizeAgentInput(input)
  const id = randomUUID()
  await db.insert(agents).values({
    id,
    userId,
    name: next.name,
    description: next.description || null,
    model: next.model,
    systemPrompt: next.systemPrompt,
    instructions: next.systemPrompt,
    temperature: next.temperature,
  })
  revalidatePath("/agents")
  return agentSlug(next.name)
}

// ----- create from a curated 1-click template -----

export async function createAgentFromTemplate(templateId: string) {
  const t = AGENT_TEMPLATES.find((tpl) => tpl.id === templateId)
  if (!t) {
    throw new Error(`Unknown template: ${templateId}`)
  }
  const userId = await requireUserId()
  const id = randomUUID()
  const row = agentRowFromTemplate(t, { id, userId })
  await db.insert(agents).values(row)
  revalidatePath("/agents")
  return agentSlug(row.name)
}

// ----- full eve-style configuration update -----
// AgentConfigInput + normalizeAgentConfigInput now live in lib/agent-normalize.ts
// (shared with the import path); imported above. (No re-export here: a
// `"use server"` module may only export async actions.)

export async function updateAgentConfig(id: string, input: AgentConfigInput) {
  const userId = await requireUserId()
  const next = normalizeAgentConfigInput(input)

  await db
    .update(agents)
    .set({
      name: next.name,
      description: next.description || null,
      enabled: next.enabled,
      model: next.model,
      temperature: next.temperature,
      maxSteps: next.maxSteps,
      instructions: next.instructions,
      // keep systemPrompt in sync for the runtime/runner
      systemPrompt: next.instructions,
      skills: next.skills,
      connectionIds: next.connectionIds,
      subagents: next.subagents,
      schedules: next.schedules,
      sandbox: next.sandbox,
      harness: next.harness,
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, id), eq(agents.userId, userId)))
  // Revalidate ONLY the list (cheap). We intentionally do NOT revalidate
  // `/agents/${id}`: that forces a full re-render of the detail page inside the
  // action response, which re-runs getAgentSecretStatus (multiple cross-region
  // auth round-trips + a possible Vercel API call) on every save. The editor is
  // a client component already holding the saved state, so a server re-render
  // here buys nothing but latency.
  revalidatePath("/agents")
}

export async function deleteAgent(id: string) {
  const userId = await requireUserId()

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.userId, userId)))
    .limit(1)
  if (!agent) return

  // Tear down the agent's deployed Vercel project (its production runtime)
  // BEFORE removing the DB row — otherwise we'd orphan a live, billable
  // deployment we can no longer reach. If no Vercel token is configured
  // (local dev / Vercel not connected) we can't delete it, so we skip and let
  // the DB delete proceed. But when we DO have credentials and the API call
  // fails, we throw before touching the DB so the caller can retry rather than
  // silently leaving the deployment alive.
  //
  // EXCEPTION: imported agents are linked to a Vercel project agent-army did NOT
  // create — the operator owns it. Deleting the row must NEVER destroy their
  // deployment; it only unlinks from the fleet. They delete it in Vercel
  // themselves (the delete dialog says so).
  if (!agent.imported) {
    let auth: { token: string; teamId?: string } | null = null
    try {
      auth = await resolveVercelAuth()
    } catch {
      auth = null // no token → nothing we can delete remotely
    }
    if (auth) {
      const slug = projectName(agent)
      await deleteProject({ token: auth.token, teamId: auth.teamId }, slug)
    }
  }

  // Unassign this agent from any channels.
  await db
    .update(channels)
    .set({ agentId: null, status: "disconnected" })
    .where(and(eq(channels.agentId, id), eq(channels.userId, userId)))
  await db
    .delete(agents)
    .where(and(eq(agents.id, id), eq(agents.userId, userId)))
  revalidatePath("/agents")
  revalidatePath("/channels")
}
