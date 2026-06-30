// Self-healing Vercel Trace Drain management. ensureTraceDrain() is idempotent:
// it creates the drain that streams agent OTel spans into /api/drains/traces if
// it doesn't exist yet, and reports plan_blocked when the team's plan (Hobby /
// Pro Trial) doesn't allow drains — so the day the plan is upgraded, the next
// call wires it up with no manual step. fetchImpl is injectable for tests,
// mirroring lib/vercel/client.ts.

export type DrainState =
  | { status: "active"; id: string }
  | { status: "plan_blocked" }
  | { status: "unconfigured" }
  | { status: "error"; message: string }

type VercelDrain = {
  id: string
  schemas?: Record<string, unknown>
  delivery?: { endpoint?: string }
}

// Pure: does an existing drain stream traces to our endpoint already?
export function findTraceDrain(
  drains: VercelDrain[],
  endpoint: string,
): { id: string } | null {
  const hit = drains.find(
    (d) => d.delivery?.endpoint === endpoint && d.schemas?.trace !== undefined,
  )
  return hit ? { id: hit.id } : null
}

export type EnsureDrainConfig = {
  token?: string
  teamId?: string
  secret?: string
  endpoint?: string
  fetchImpl?: typeof fetch
}

export async function ensureTraceDrain(cfg: EnsureDrainConfig): Promise<DrainState> {
  const { token, teamId, secret, endpoint } = cfg
  if (!token || !teamId || !secret || !endpoint) {
    return { status: "unconfigured" }
  }
  const fetchImpl = cfg.fetchImpl ?? fetch
  const base = `https://api.vercel.com/v1/drains?teamId=${encodeURIComponent(teamId)}`
  const auth = { Authorization: `Bearer ${token}` }

  // 1. List existing drains.
  const listRes = await fetchImpl(base, { headers: auth })
  if (listRes.status === 403) return { status: "plan_blocked" }
  if (!listRes.ok) {
    return { status: "error", message: `list drains failed (${listRes.status})` }
  }
  const { drains = [] } = (await listRes.json()) as { drains?: VercelDrain[] }
  const existing = findTraceDrain(drains, endpoint)
  if (existing) return { status: "active", id: existing.id }

  // 2. Create it.
  const createRes = await fetchImpl(base, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "agent-army observability",
      projects: "all",
      schemas: { trace: { version: "v1" } },
      delivery: {
        type: "http",
        endpoint,
        encoding: "json",
        headers: {},
        secret,
      },
    }),
  })
  if (createRes.status === 403) return { status: "plan_blocked" }
  if (!createRes.ok) {
    return { status: "error", message: `create drain failed (${createRes.status})` }
  }
  const created = (await createRes.json()) as { id: string }
  return { status: "active", id: created.id }
}
