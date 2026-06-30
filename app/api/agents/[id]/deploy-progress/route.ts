import { getAgent } from "@/app/actions/agents"
import { getSessionUser } from "@/lib/session"
import { resolveVercelAuth } from "@/lib/vercel/auth"
import { listDeployments, getBuildEvents } from "@/lib/vercel/client"
import { summarizeDeployProgress } from "@/lib/vercel/deploy"
import { projectName } from "@/lib/eve/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Live deploy-progress poll for the redeploy modal.
 *
 * GET /api/agents/{id}/deploy-progress?since=<clickEpochMs>
 *   → { phase, deploymentId, url, state, logs[] }
 *
 * This is a ROUTE HANDLER, not a server action, on purpose: Next serializes
 * server actions, so a poll would queue behind the minutes-long deployAgent
 * action and never update. Route handlers run concurrently, so the modal can
 * poll this while deployAgent is mid-build.
 *
 * `since` is the timestamp the user clicked Deploy; summarizeDeployProgress
 * ignores any deployment older than it (a prior build) so the modal doesn't
 * flash the previous deployment's READY state before the new one registers.
 *
 * SECURITY: operator-session gated; scoped to the caller's own agent via
 * getAgent; the slug is the injection-safe projectName() (re-asserted), never a
 * client string; Vercel tokens never reach the client (errors are swallowed to
 * a "preparing" shape so a transient Vercel hiccup doesn't break the modal).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return new Response("Unauthorized", { status: 401 })

  const { id } = await params
  const agent = await getAgent(id)
  if (!agent) return new Response("Agent not found", { status: 404 })

  const since = Number(new URL(request.url).searchParams.get("since")) || 0

  try {
    const slug = projectName(agent)
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
      throw new Error("Could not derive a safe project name")
    }

    const { token, teamId } = await resolveVercelAuth()
    const cfg = { token, teamId }

    const list = await listDeployments(cfg, slug, 5)
    const progress = summarizeDeployProgress(list, since)
    const logs = progress.deploymentId
      ? await getBuildEvents(cfg, progress.deploymentId)
      : []

    return Response.json({ ...progress, logs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[deploy-progress] failed for ${id}:`, message)
    // Degrade to "preparing" so a transient Vercel error keeps the modal alive.
    return Response.json({
      phase: "preparing",
      deploymentId: null,
      url: null,
      state: null,
      createdAt: null,
      logs: [],
    })
  }
}
