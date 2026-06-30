"use server"

import { db } from "@/lib/db"
import { agents } from "@/lib/db/schema"
import { requireUserId } from "@/lib/session"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import {
  listProjects,
  getProductionDeploymentId,
  getDeploymentFileTree,
  getDeploymentFile,
  resolveProjectId,
} from "@/lib/vercel/client"
import { discoverEveAgent } from "@/lib/eve/discover"
import { normalizeAgentConfigInput } from "@/lib/agent-normalize"
import { projectName } from "@/lib/eve/project"
import { agentConfigHash, agentConfigSnapshot } from "@/lib/eve/config-drift"
import { agentSlug } from "@/lib/slug"
import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { randomUUID } from "crypto"

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/
// Only source files matter; the deployment tree also carries build-output
// lambdas (out/...) and node_modules. Cap the fetch fan-out as a backstop.
const MAX_SOURCE_FILES = 200

export type DiscoverableProject = {
  slug: string
  name: string
  /** True when an existing agent row already maps to this project. */
  alreadyImported: boolean
  /** False when the project has never been promoted to production. */
  hasProduction: boolean
}

/**
 * List the team's Vercel projects that look like Eve agents (framework "eve"),
 * for the import picker. Each is flagged `alreadyImported` (an agents row whose
 * deterministic projectName matches) and `hasProduction` (has a promoted prod
 * deployment to read source from). Degrades to `{projects:[]}` on any Vercel
 * error, matching getAgentDeployments' fail-soft contract.
 */
export async function discoverDeployedAgents(): Promise<{
  projects: DiscoverableProject[]
}> {
  const userId = await requireUserId()
  try {
    const { token, teamId } = await resolveVercelAuth()
    const { projects } = await listProjects({ token, teamId }, { limit: 100 })

    const rows = await db.select().from(agents).where(eq(agents.userId, userId))
    const importedNames = new Set(rows.map((r) => projectName(r)))

    const candidates = projects
      .filter((p) => p.framework === "eve")
      .map((p) => ({
        slug: p.name,
        name: p.name,
        alreadyImported: importedNames.has(p.name),
        hasProduction: p.productionDeploymentId !== null,
      }))
    return { projects: candidates }
  } catch (err) {
    console.error(
      `[discoverDeployedAgents] list failed:`,
      err instanceof Error ? err.message : String(err),
    )
    return { projects: [] }
  }
}

/**
 * Import a deployed Eve project (by its Vercel project slug) into agent-army:
 * read its production deployment's source files, reverse-parse them
 * (discoverEveAgent), and INSERT (or UPDATE on re-import) an agents row.
 *
 * Lossy by design: secrets (connection tokens, channel creds, AI gateway key),
 * temperature and maxSteps live only in the deployment's encrypted env and are
 * NOT recovered; they default and are flagged in `warnings`. The live bot keeps
 * running on its existing env; a dashboard re-Deploy needs the secrets re-entered.
 *
 * SECURITY: the client-supplied slug is re-validated against the project-name
 * grammar; the Vercel token never reaches the client or any thrown error.
 */
export async function importAgent(slug: string): Promise<{
  slug: string
  warnings: string[]
}> {
  const userId = await requireUserId()
  if (!SLUG_RE.test(slug)) {
    throw new Error("Invalid project name")
  }

  const { token, teamId } = await resolveVercelAuth()
  const cfg = { token, teamId }

  const prodDeploymentId = await getProductionDeploymentId(cfg, slug)
  if (!prodDeploymentId) {
    throw new Error("This project has no production deployment to import")
  }
  // The real Vercel PROJECT id (prj_…), so it matches OTel spans' vercel.projectId,
  // NOT the deployment id. Fail loudly rather than store a wrong value (the
  // project must exist; getProductionDeploymentId just succeeded for this slug).
  const vercelProjectId = await resolveProjectId(cfg, slug)

  // Read the source tree, keep only the agent/** + package.json files (strip the
  // deployment's `src/` wrapper; skip out/ lambdas), and fetch their contents.
  const tree = await getDeploymentFileTree(cfg, prodDeploymentId)
  const wanted = tree
    .map((f) => ({ ...f, key: f.path.replace(/^src\//, "") }))
    .filter((f) => f.key === "package.json" || f.key.startsWith("agent/"))
    .slice(0, MAX_SOURCE_FILES)

  const fileMap: Record<string, string> = {}
  await Promise.all(
    wanted.map(async (f) => {
      fileMap[f.key] = await getDeploymentFile(cfg, prodDeploymentId, f.uid)
    }),
  )

  const discovered = discoverEveAgent(fileMap) // throws if not an eve agent

  // Normalize the recovered config through the SAME validator the editor uses.
  // connectionIds stay empty: the global connection rows (with tokens) don't
  // exist in this account yet; re-add them before redeploying.
  const config = normalizeAgentConfigInput({
    name: discovered.name,
    description: null,
    enabled: true,
    model: discovered.model,
    temperature: 70,
    maxSteps: 10,
    instructions: discovered.systemPrompt,
    skills: discovered.skills.map((s) => ({
      id: randomUUID(),
      name: s.name,
      description: s.description,
      content: s.content,
    })),
    connectionIds: [],
    subagents: discovered.subagents.map((s) => ({
      id: randomUUID(),
      name: s.name,
      model: s.model,
      instructions: s.instructions,
    })),
    schedules: discovered.schedules.map((s) => ({
      id: randomUUID(),
      name: s.name,
      cron: s.cron,
      prompt: s.prompt,
      enabled: true,
    })),
    sandbox: discovered.sandbox.enabled
      ? {
          enabled: true,
          runtime: discovered.sandbox.runtime,
          setupCommands: discovered.sandbox.setupCommands,
        }
      : { enabled: false },
    harness: discovered.harness,
  })

  // Idempotency + id strategy. The strongest key is the baked AGENT_ID: a row
  // already carrying it IS the same logical agent → UPDATE it (re-register). Else
  // fall back to a row whose deterministic projectName matches this Vercel slug
  // (a project deployed by agent-army). Else INSERT, reusing the baked AGENT_ID
  // when free (so the deployed runtime's /api/agents/<id>/runtime-config resolves
  // to this row); it can't be owned by another row here, or the first lookup
  // would have matched it. Only a slug-matched row with a different id, or no
  // baked id at all, yields a fresh id.
  const rows = await db.select().from(agents).where(eq(agents.userId, userId))
  const expectedDeploymentUrl = `https://${slug}.vercel.app`
  // The ONLY trustworthy identity for an imported agent is its stored
  // deploymentUrl, real external Vercel metadata. projectName(row) and the baked
  // AGENT_ID are both attacker-influenceable (a malicious project's slug is
  // operator-chosen and its source is untrusted), so neither may select the row
  // we UPDATE. They are used only to REJECT collisions with a managed agent.
  const projectRow = rows.find((r) => r.deploymentUrl === expectedDeploymentUrl)
  const slugRow = rows.find((r) => projectName(r) === slug)
  const idRow = discovered.sourceAgentId
    ? rows.find((r) => r.id === discovered.sourceAgentId)
    : undefined

  // NEVER clobber an agent agent-army already fully manages: importing would
  // overwrite its (richer) config with the lossy recovered one and downgrade it
  // to update-only. Reject if THIS project, the imported slug's deterministic
  // name, or the baked id resolves to a managed (imported=false) row.
  for (const r of [projectRow, slugRow, idRow]) {
    if (r && !r.imported) {
      throw new Error(
        "This project is already managed in agent-army — open it from the Agents list instead of importing.",
      )
    }
  }

  // Update target: ONLY a previously-imported row bound to THIS Vercel project by
  // its deployment URL. Anything else → insert a fresh row.
  const existing = projectRow
  // Reuse the baked AGENT_ID only when no row already owns it (else a fresh
  // UUID: reusing it would collide with idRow or let a cross-project baked id
  // claim another row's identity).
  const id =
    existing?.id ??
    (discovered.sourceAgentId && !idRow ? discovered.sourceAgentId : randomUUID())

  const buildRow = {
    name: config.name,
    description: config.description ?? null,
    model: config.model,
    systemPrompt: discovered.systemPrompt || config.instructions,
    instructions: config.instructions,
    temperature: config.temperature,
    maxSteps: config.maxSteps,
    enabled: config.enabled,
    skills: config.skills,
    toolIds: [] as string[],
    connectionIds: config.connectionIds,
    subagents: config.subagents,
    schedules: config.schedules,
    sandbox: config.sandbox,
    harness: config.harness,
  }
  const deployBookkeeping = {
    vercelProjectId,
    deploymentUrl: `https://${slug}.vercel.app`,
    deploymentStatus: "deployed" as const,
    eveVersion: discovered.eveVersion,
    lastDeployedAt: new Date(),
    deploymentError: null,
    // Marks this as a linked/external deployment: the dashboard restricts it to
    // prompt updates and never tears down its Vercel project on delete.
    imported: true,
    updatedAt: new Date(),
  }

  const writeValues = { ...buildRow, ...deployBookkeeping }
  const [persisted] = existing
    ? await db.update(agents).set(writeValues).where(eq(agents.id, existing.id)).returning()
    : await db.insert(agents).values({ id, userId, ...writeValues }).returning()

  // Stamp the deploy snapshot/hash from the PERSISTED row returned by the write
  // (not the in-memory build object): Postgres canonicalizes jsonb key order on
  // write, so hashing the pre-write JS objects would mismatch the row a later
  // read sees and show a false "needs redeploy" drift badge. `.returning()` gives
  // the stored form in the same statement, with no stale-read race against the pooler.
  if (persisted) {
    await db
      .update(agents)
      .set({
        deployedConfig: agentConfigSnapshot(persisted),
        deployedConfigHash: agentConfigHash(persisted),
      })
      .where(eq(agents.id, id))
  }

  revalidatePath("/agents")

  // Surface what could NOT be recovered, so the operator knows to reconcile it.
  const warnings = [...discovered.warnings]
  if (discovered.connections.length > 0) {
    warnings.push(
      `${discovered.connections.length} MCP connection(s) were detected but their tokens live in the deployment's encrypted env — re-add them before redeploying.`,
    )
  }
  if (discovered.channel && discovered.channel.type !== "slack") {
    warnings.push(
      `Channel "${discovered.channel.type}" credentials are not recoverable from source — re-enter them before redeploying.`,
    )
  }
  warnings.push("Temperature and max steps were reset to defaults (not stored in the deployment).")
  if (!existing && id !== discovered.sourceAgentId) {
    warnings.push(
      "A new agent id was assigned; the live bot keeps its baked-in prompt until you redeploy.",
    )
  }

  return { slug: agentSlug(config.name), warnings }
}
