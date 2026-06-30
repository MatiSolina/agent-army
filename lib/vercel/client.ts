/**
 * Vercel REST API client: fetch orchestration with injectable fetch for tests.
 * No React/Next imports. No env reads; caller passes token/teamId via cfg.
 */

import {
  parseDeploymentResponse,
  classifyReadyState,
  extractBuildErrorText,
  extractBuildLogLines,
  parseEnvKeysResponse,
  parseDeploymentsList,
  parseProductionDeploymentId,
  parseProjectsList,
  flattenDeploymentFiles,
  decodeDeploymentFileBody,
  type ProjectSummary,
  type DeploymentFileEntry,
} from "./deploy"
import type { EnvVarSpec } from "@/lib/eve/env-spec"

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export type VercelClientConfig = {
  token: string
  teamId?: string
  fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function apiUrl(path: string, params: Record<string, string | undefined>): string {
  const base = `https://api.vercel.com${path}`
  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined) qs.set(key, val)
  }
  const queryString = qs.toString()
  return queryString ? `${base}?${queryString}` : base
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

// ---------------------------------------------------------------------------
// createDeployment
// ---------------------------------------------------------------------------

export async function createDeployment(
  cfg: VercelClientConfig,
  args: {
    name: string
    files: { file: string; data: string; encoding: "utf-8" }[]
  }
): Promise<{ id: string; url: string; readyState: string; projectId: string | null }> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl("/v13/deployments", {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
    skipAutoDetectionConfirmation: "1",
  })
  // Vercel "blue/green" (== `vercel --prod --skip-domain`): build a
  // production-eligible deployment but DON'T point the production domain at it
  // yet (autoAssignCustomDomains:false). The non-technical user tests this
  // build's own unique URL via the web chat, then promoteDeployment() flips the
  // production domain to it. A plain PREVIEW deploy (no target) CANNOT be
  // promoted: `/v10/.../promote` rejects it with 422, so the whole "test then
  // publish" flow only works if the build targets production from the start.
  // NOTE: no inline `env`. Secrets live on the project (upsertProjectEnv),
  // and the deployment inherits them; per-deployment inline env is superseded.
  const body = {
    name: args.name,
    project: args.name,
    target: "production",
    autoAssignCustomDomains: false,
    projectSettings: { framework: "eve" },
    files: args.files,
  }
  const res = await fetchImpl(url, {
    method: "POST",
    headers: bearerHeaders(cfg.token),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Vercel create deployment failed: ${res.status} ${text.slice(0, 1000)}`
    )
  }
  return parseDeploymentResponse(await res.json())
}

// ---------------------------------------------------------------------------
// getDeployment
// ---------------------------------------------------------------------------

export async function getDeployment(
  cfg: VercelClientConfig,
  id: string
): Promise<{ id: string; url: string; readyState: string }> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v13/deployments/${id}`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Vercel get deployment failed: ${res.status} ${text.slice(0, 1000)}`
    )
  }
  return parseDeploymentResponse(await res.json())
}

// ---------------------------------------------------------------------------
// getBuildErrorText
// ---------------------------------------------------------------------------

export async function getBuildErrorText(
  cfg: VercelClientConfig,
  id: string
): Promise<string> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v3/deployments/${id}/events`, {
    builds: "1",
    "limit": "-1",
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (!res.ok) return "(could not fetch build logs)"
  return extractBuildErrorText(await res.json())
}

// ---------------------------------------------------------------------------
// getBuildEvents: ordered live build log tail (for the redeploy modal)
// ---------------------------------------------------------------------------

/**
 * Fetch the deployment's build events and return them as an ordered log tail.
 * Same endpoint as getBuildErrorText, but keeps every line (not just errors) so
 * the redeploy modal can stream the build in real time. Never throws: a non-2xx
 * yields [] so a transient poll failure just shows no new lines.
 */
export async function getBuildEvents(
  cfg: VercelClientConfig,
  id: string,
): Promise<string[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v3/deployments/${id}/events`, {
    builds: "1",
    limit: "-1",
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (!res.ok) return []
  return extractBuildLogLines(await res.json())
}

// ---------------------------------------------------------------------------
// getReadyState: single-shot, no loop
// ---------------------------------------------------------------------------

/**
 * One HTTP call: classify a deployment's `readyState` into READY / ERROR /
 * BUILDING. The workflow drives this itself with durable `sleep`s so no step
 * blocks for minutes; {@link pollUntilReady} keeps its blocking loop for the
 * server-action path by calling this each iteration.
 */
export async function getReadyState(
  cfg: VercelClientConfig,
  id: string,
): Promise<"READY" | "ERROR" | "BUILDING"> {
  const deployment = await getDeployment(cfg, id)
  const classification = classifyReadyState(deployment.readyState)
  if (classification === "ready") return "READY"
  if (classification === "error") return "ERROR"
  return "BUILDING"
}

// ---------------------------------------------------------------------------
// pollUntilReady
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_INTERVAL_MS = 3000

export async function pollUntilReady(
  cfg: VercelClientConfig,
  id: string,
  opts?: {
    timeoutMs?: number
    intervalMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }
): Promise<{ url: string; readyState: string }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS
  const sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = opts?.now ?? (() => Date.now())

  const start = now()

  while (true) {
    // getReadyState classifies; we also fetch the raw deployment for url/state
    // on the terminal paths (READY return / ERROR message / timeout message).
    const deployment = await getDeployment(cfg, id)
    const state = classifyReadyState(deployment.readyState)

    if (state === "ready") {
      return { url: deployment.url, readyState: "READY" }
    }
    if (state === "error") {
      const errorText = await getBuildErrorText(cfg, id)
      throw new Error(
        `Deployment build failed (${deployment.readyState}): ${errorText}`,
      )
    }

    // pending
    const elapsed = now() - start
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Deployment timed out after ${timeoutMs}ms (last state: ${deployment.readyState})`,
      )
    }
    await sleep(intervalMs)
  }
}

// ---------------------------------------------------------------------------
// ensureProject: GET-then-create, idempotent + race-safe
// ---------------------------------------------------------------------------

/**
 * Ensure a Vercel project named `name` exists, so a later env upsert + deploy
 * can target it. GET /v9/projects/{name}: 200 → already exists; 404 → create
 * via POST /v11/projects {name}. A name-collision error on POST (lost race with
 * a concurrent create) is treated as success. We do NOT send a `framework` on
 * create: the framework ("eve") is supplied per-deployment in createDeployment,
 * and an unexpected framework value would 400 here.
 *
 * SECURITY: the token is never included in any thrown error.
 */
export async function ensureProject(
  cfg: VercelClientConfig,
  name: string,
): Promise<{ existed: boolean }> {
  const fetchImpl = cfg.fetchImpl ?? fetch

  const getUrl = apiUrl(`/v9/projects/${name}`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const getRes = await fetchImpl(getUrl, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (getRes.ok) return { existed: true }
  if (getRes.status !== 404) {
    const text = await getRes.text()
    throw new Error(
      `Vercel get project failed: ${getRes.status} ${text.slice(0, 500)}`,
    )
  }

  // Not found → create.
  const postUrl = apiUrl("/v11/projects", {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const postRes = await fetchImpl(postUrl, {
    method: "POST",
    headers: bearerHeaders(cfg.token),
    body: JSON.stringify({ name }),
  })
  if (postRes.ok) return { existed: false }

  // Lost a create race → another caller already made it. Treat as existing.
  const text = await postRes.text()
  if (/already.?exists|project_name_already/i.test(text)) {
    return { existed: true }
  }
  throw new Error(
    `Vercel create project failed: ${postRes.status} ${text.slice(0, 500)}`,
  )
}

// ---------------------------------------------------------------------------
// attachConnectorToProject: grant a project access to a Vercel Connect connector
// ---------------------------------------------------------------------------

/**
 * Attach a Vercel Connect connector (by UID, e.g. "slack/agentarmy") to a
 * project (by name or id) for all environments, so the project's runtime OIDC
 * can exchange for the connector's token. Required for eve `connect()` to work
 * on a deployed agent: the connector exists at the team level but each
 * consuming project must be attached.
 *
 * Resolves the connector UID → id and the project name → id, then
 * `POST /v1/connect/connectors/{connectorId}/projects/{projectId}`. Throws on
 * any non-2xx (callers decide whether to treat attach as best-effort).
 */
export async function attachConnectorToProject(
  cfg: VercelClientConfig,
  connectorUid: string,
  projectName: string,
): Promise<void> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const params = cfg.teamId ? { teamId: cfg.teamId } : {}

  const connRes = await fetchImpl(
    apiUrl(`/v1/connect/connectors/${encodeURIComponent(connectorUid)}`, params),
    { method: "GET", headers: bearerHeaders(cfg.token) },
  )
  if (!connRes.ok) {
    throw new Error(`Resolve connector "${connectorUid}" failed: ${connRes.status}`)
  }
  const connectorId = ((await connRes.json()) as { id?: string }).id
  if (!connectorId) throw new Error(`Connector "${connectorUid}" has no id`)

  const projRes = await fetchImpl(
    apiUrl(`/v9/projects/${encodeURIComponent(projectName)}`, params),
    { method: "GET", headers: bearerHeaders(cfg.token) },
  )
  if (!projRes.ok) {
    throw new Error(`Resolve project "${projectName}" failed: ${projRes.status}`)
  }
  const projectId = ((await projRes.json()) as { id?: string }).id
  if (!projectId) throw new Error(`Project "${projectName}" has no id`)

  const attachRes = await fetchImpl(
    apiUrl(`/v1/connect/connectors/${connectorId}/projects/${projectId}`, params),
    {
      method: "POST",
      headers: bearerHeaders(cfg.token),
      body: JSON.stringify({
        environments: ["production", "preview", "development"],
      }),
    },
  )
  if (!attachRes.ok) {
    const text = await attachRes.text()
    throw new Error(
      `Attach connector "${connectorUid}" to "${projectName}" failed: ${attachRes.status} ${text.slice(0, 300)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// listConnectors: enumerate the team's Vercel Connect connectors
// ---------------------------------------------------------------------------

export type ConnectorSummary = {
  uid: string
  type: string
  supportsTriggers: boolean
}

/**
 * List the team's Vercel Connect connectors (`GET /v1/connect/connectors` →
 * `{clients:[...]}`). Best-effort: returns [] on any failure so a UI picker
 * degrades to manual entry rather than erroring. Never throws.
 */
export async function listConnectors(
  cfg: VercelClientConfig,
): Promise<ConnectorSummary[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const params = cfg.teamId ? { teamId: cfg.teamId } : {}
  try {
    const res = await fetchImpl(apiUrl(`/v1/connect/connectors`, params), {
      method: "GET",
      headers: bearerHeaders(cfg.token),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { clients?: unknown }
    const clients = Array.isArray(body.clients) ? body.clients : []
    return clients.map((c) => {
      const o = c as Record<string, unknown>
      return {
        uid: String(o.uid ?? ""),
        type: String(o.type ?? ""),
        supportsTriggers: Boolean(o.supportsTriggers),
      }
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// attachTriggerDestination: route a connector's inbound triggers to a project
// ---------------------------------------------------------------------------

/**
 * Point a Vercel Connect connector's inbound triggers (e.g. Slack Event
 * Subscriptions) at a project route. This is the REST equivalent of
 * `vercel connect attach <uid> --triggers --trigger-path <path>`: resolve the
 * connector UID → id and project name → id, then
 * `PATCH /v1/connect/connectors/{id}/trigger-destinations` with
 * `{ destinations: [{ projectId, path }] }`. Needed so Slack delivers
 * app_mention/message.im to the agent's eve Slack route (/eve/v1/slack).
 *
 * NOTE: undocumented endpoint (derived from the Vercel CLI). It also requires
 * the team's trigger entitlement + a trigger-capable connector (Slack today);
 * those gates would block the CLI just the same. Throws on any non-2xx so the
 * caller can decide whether to treat it as best-effort.
 */
export async function attachTriggerDestination(
  cfg: VercelClientConfig,
  connectorUid: string,
  projectName: string,
  path: string,
): Promise<void> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const params = cfg.teamId ? { teamId: cfg.teamId } : {}

  const connRes = await fetchImpl(
    apiUrl(`/v1/connect/connectors/${encodeURIComponent(connectorUid)}`, params),
    { method: "GET", headers: bearerHeaders(cfg.token) },
  )
  if (!connRes.ok) {
    throw new Error(`Resolve connector "${connectorUid}" failed: ${connRes.status}`)
  }
  const connectorId = ((await connRes.json()) as { id?: string }).id
  if (!connectorId) throw new Error(`Connector "${connectorUid}" has no id`)

  const projRes = await fetchImpl(
    apiUrl(`/v9/projects/${encodeURIComponent(projectName)}`, params),
    { method: "GET", headers: bearerHeaders(cfg.token) },
  )
  if (!projRes.ok) {
    throw new Error(`Resolve project "${projectName}" failed: ${projRes.status}`)
  }
  const projectId = ((await projRes.json()) as { id?: string }).id
  if (!projectId) throw new Error(`Project "${projectName}" has no id`)

  const patchRes = await fetchImpl(
    apiUrl(`/v1/connect/connectors/${connectorId}/trigger-destinations`, params),
    {
      method: "PATCH",
      headers: bearerHeaders(cfg.token),
      body: JSON.stringify({ destinations: [{ projectId, path }] }),
    },
  )
  if (!patchRes.ok) {
    const text = await patchRes.text()
    throw new Error(
      `Attach trigger destination "${connectorUid}" → "${projectName}${path}" failed: ${patchRes.status} ${text.slice(0, 300)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// deleteProject: tear down the project and all its deployments/domains/env
// ---------------------------------------------------------------------------

/**
 * Delete a Vercel project (and all its deployments, domains and env vars).
 * DELETE /v9/projects/{name}. Idempotent: a 404 (already gone, or never
 * deployed) is treated as success → returns existed:false. Any other non-OK
 * status throws.
 *
 * SECURITY: the token is never included in any thrown error.
 */
export async function deleteProject(
  cfg: VercelClientConfig,
  name: string,
): Promise<{ existed: boolean }> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v9/projects/${encodeURIComponent(name)}`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "DELETE",
    headers: bearerHeaders(cfg.token),
  })
  if (res.ok) return { existed: true }
  if (res.status === 404) return { existed: false }
  const text = await res.text()
  throw new Error(
    `Vercel delete project failed: ${res.status} ${text.slice(0, 500)}`,
  )
}

// ---------------------------------------------------------------------------
// deleteDeployment: tear down a SINGLE deployment (preview-test housekeeping)
// ---------------------------------------------------------------------------

/**
 * Delete a single Vercel deployment by id (NOT the whole project). DELETE
 * /v13/deployments/{id}. Used by the gated-eve-bump preview-test failure path so
 * a never-promoted pinned preview does not linger and consume quota; the
 * project (and its prod deployment) must survive. Idempotent: a 404 (already
 * gone) is treated as success → returns existed:false. Any other non-OK throws.
 *
 * The id is encodeURIComponent-escaped so a value with reserved chars can't break
 * the URL. SECURITY: the token is never included in any thrown error.
 */
export async function deleteDeployment(
  cfg: VercelClientConfig,
  deploymentId: string,
): Promise<{ existed: boolean }> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "DELETE",
    headers: bearerHeaders(cfg.token),
  })
  if (res.ok) return { existed: true }
  if (res.status === 404) return { existed: false }
  const text = await res.text()
  throw new Error(
    `Vercel delete deployment failed: ${res.status} ${text.slice(0, 500)}`,
  )
}

// ---------------------------------------------------------------------------
// upsertProjectEnv: persist encrypted env vars onto the project
// ---------------------------------------------------------------------------

/**
 * Upsert (create-or-update) the given env vars onto the project. Idempotent via
 * `upsert=true`, so re-deploys never duplicate or error on existing keys. Each
 * var is stored as `type:"encrypted"` for both production + preview.
 *
 * No-op when `specs` is empty (no request issued).
 *
 * SECURITY: secret VALUES are sent in the request body but NEVER appear in any
 * thrown error: only HTTP status text (capped) and offending KEYS surface.
 */
export async function upsertProjectEnv(
  cfg: VercelClientConfig,
  name: string,
  specs: EnvVarSpec[],
): Promise<void> {
  if (specs.length === 0) return
  const fetchImpl = cfg.fetchImpl ?? fetch

  const url = apiUrl(`/v10/projects/${name}/env`, {
    upsert: "true",
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const body = specs.map((s) => ({
    key: s.key,
    value: s.value,
    type: "encrypted",
    target: ["production", "preview"],
  }))
  const res = await fetchImpl(url, {
    method: "POST",
    headers: bearerHeaders(cfg.token),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // Read+discard the body so the value can't leak; report status only.
    await res.text().catch(() => "")
    throw new Error(`Vercel upsert env failed: ${res.status}`)
  }

  // The endpoint returns 200 even when some entries fail; inspect `failed[]`.
  const json = (await res.json().catch(() => null)) as unknown
  const failed =
    json && typeof json === "object"
      ? (json as Record<string, unknown>).failed
      : undefined
  if (Array.isArray(failed) && failed.length > 0) {
    // Surface offending KEYS only, never the values.
    const keys = failed
      .map((f) => {
        if (!f || typeof f !== "object") return undefined
        const err = (f as Record<string, unknown>).error
        if (err && typeof err === "object") {
          const k = (err as Record<string, unknown>).key
          if (typeof k === "string") return k
        }
        const k = (f as Record<string, unknown>).key
        return typeof k === "string" ? k : undefined
      })
      .filter((k): k is string => typeof k === "string")
    throw new Error(
      `Vercel upsert env reported failed entries: ${keys.join(", ") || "(unknown keys)"}`,
    )
  }
}

// ---------------------------------------------------------------------------
// listProjectEnvKeys: masked key listing for "configured" badges
// ---------------------------------------------------------------------------

/**
 * List the env vars on the project, returning KEYS ONLY (key/target/type).
 * `decrypt` is never set, so the API returns masked values, and we drop the
 * value field entirely via parseEnvKeysResponse regardless. A 404 (project not
 * created yet) yields `[]`.
 */
export async function listProjectEnvKeys(
  cfg: VercelClientConfig,
  name: string,
): Promise<{ key: string; target: string[]; type: string }[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v10/projects/${name}/env`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (res.status === 404) return []
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Vercel list env failed: ${res.status} ${text.slice(0, 500)}`,
    )
  }
  return parseEnvKeysResponse(await res.json())
}

// ---------------------------------------------------------------------------
// promoteDeployment: promote/rollback a built deploy to production
// ---------------------------------------------------------------------------

/**
 * Resolve a project NAME to its `prj_…` id. GET /v9/projects/{name} accepts the
 * name; the promote endpoint does not, so we resolve here first.
 * SECURITY: the token is never included in a thrown error.
 */
export async function resolveProjectId(
  cfg: VercelClientConfig,
  projectName: string,
): Promise<string> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v9/projects/${encodeURIComponent(projectName)}`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Vercel resolve project failed: ${res.status} ${text.slice(0, 500)}`,
    )
  }
  const data = (await res.json()) as { id?: string }
  if (!data.id) throw new Error("Vercel resolve project failed: no project id")
  return data.id
}

/**
 * Promote an already-built deployment to production with NO rebuild (Vercel's
 * native primitive). This is both "promote a preview" and "rollback to an older
 * deployment": rollback is just promoting an earlier one. POST /v10/projects/
 * {projectName}/promote/{deploymentId} with an empty body.
 *
 * Path segments are encodeURIComponent-escaped so a slug/id with reserved chars
 * can't break the URL. SECURITY: the token is never included in a thrown error.
 */
export async function promoteDeployment(
  cfg: VercelClientConfig,
  projectName: string,
  deploymentId: string,
): Promise<void> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  // The promote endpoint resolves the project by ID ONLY; passing the name
  // 404s ("Project not found") even though /v9/projects/{name} accepts it.
  const projectId = await resolveProjectId(cfg, projectName)
  const url = apiUrl(
    `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
    { ...(cfg.teamId ? { teamId: cfg.teamId } : {}) },
  )
  const res = await fetchImpl(url, {
    method: "POST",
    headers: bearerHeaders(cfg.token),
    body: "{}",
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Vercel promote deployment failed: ${res.status} ${text.slice(0, 500)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// listDeployments: past deployments for the Deployments tab
// ---------------------------------------------------------------------------

/**
 * List the project's recent deployments (newest first, as Vercel returns them).
 * GET /v6/deployments?projectId={projectName}&limit={limit}. A 404 (project not
 * created yet) yields `[]`. Shape is normalized by parseDeploymentsList.
 *
 * SECURITY: the token is never included in a thrown error.
 */
export async function listDeployments(
  cfg: VercelClientConfig,
  projectName: string,
  limit = 20,
): Promise<ReturnType<typeof parseDeploymentsList>> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl("/v6/deployments", {
    projectId: projectName,
    limit: String(limit),
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (res.status === 404) return []
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Vercel list deployments failed: ${res.status} ${text.slice(0, 500)}`,
    )
  }
  return parseDeploymentsList(await res.json())
}

// ---------------------------------------------------------------------------
// getProductionDeploymentId: the deployment currently live on prod
// ---------------------------------------------------------------------------

/**
 * Return the id of the deployment currently live on the project's production
 * target, or `null` if none (never promoted) or the project doesn't exist yet
 * (404). GET /v9/projects/{projectName}, then parseProductionDeploymentId.
 *
 * SECURITY: the token is never included in a thrown error.
 */
export async function getProductionDeploymentId(
  cfg: VercelClientConfig,
  projectName: string,
): Promise<string | null> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v9/projects/${encodeURIComponent(projectName)}`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Vercel get project failed: ${res.status} ${text.slice(0, 500)}`,
    )
  }
  return parseProductionDeploymentId(await res.json())
}

// ---------------------------------------------------------------------------
// listProjects: enumerate the team's projects (for the import picker)
// ---------------------------------------------------------------------------

/**
 * List the team's Vercel projects. GET /v10/projects (the LIST endpoint; note
 * single-project reads use /v9/projects/{name}). Each entry carries its current
 * production deployment id (targets.production.id), so the import picker resolves
 * every candidate's prod deployment in this one call. `from` is the pagination
 * continuation token (pass back the returned `next`); `search` filters by name.
 *
 * SECURITY: the token is never included in a thrown error.
 */
export async function listProjects(
  cfg: VercelClientConfig,
  opts?: { limit?: number; from?: string; search?: string },
): Promise<{ projects: ProjectSummary[]; next: string | null }> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl("/v10/projects", {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
    ...(opts?.limit ? { limit: String(opts.limit) } : {}),
    ...(opts?.from ? { from: opts.from } : {}),
    ...(opts?.search ? { search: opts.search } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Vercel list projects failed: ${res.status} ${text.slice(0, 500)}`)
  }
  return parseProjectsList(await res.json())
}

// ---------------------------------------------------------------------------
// getDeploymentFileTree: the deployment's source file tree (flattened)
// ---------------------------------------------------------------------------

/**
 * Fetch a deployment's source file tree and flatten it to readable file leaves.
 * GET /v6/deployments/{id}/files (recursive tree). Only files originally uploaded
 * with the `files` key (as createDeployment does) are retrievable; build-output
 * lambdas are skipped by flattenDeploymentFiles. A 404 yields []. NOTE the
 * version skew is intentional: tree is /v6, contents below is /v8.
 *
 * SECURITY: the token is never included in a thrown error.
 */
export async function getDeploymentFileTree(
  cfg: VercelClientConfig,
  deploymentId: string,
): Promise<DeploymentFileEntry[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(`/v6/deployments/${encodeURIComponent(deploymentId)}/files`, {
    ...(cfg.teamId ? { teamId: cfg.teamId } : {}),
  })
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (res.status === 404) return []
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Vercel get deployment files failed: ${res.status} ${text.slice(0, 500)}`)
  }
  return flattenDeploymentFiles(await res.json())
}

// ---------------------------------------------------------------------------
// getDeploymentFile: a single source file's decoded text contents
// ---------------------------------------------------------------------------

/**
 * Read a single deployment source file's text by its tree `uid`. GET
 * /v8/deployments/{id}/files/{fileId} (version /v8; a wrong version 410s). The
 * body is normalized by decodeDeploymentFileBody (verified shape: {data:base64}).
 * Both path segments are encodeURIComponent-escaped.
 *
 * SECURITY: the token is never included in a thrown error.
 */
export async function getDeploymentFile(
  cfg: VercelClientConfig,
  deploymentId: string,
  fileId: string,
): Promise<string> {
  const fetchImpl = cfg.fetchImpl ?? fetch
  const url = apiUrl(
    `/v8/deployments/${encodeURIComponent(deploymentId)}/files/${encodeURIComponent(fileId)}`,
    { ...(cfg.teamId ? { teamId: cfg.teamId } : {}) },
  )
  const res = await fetchImpl(url, {
    method: "GET",
    headers: bearerHeaders(cfg.token),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Vercel get deployment file failed: ${res.status} ${text.slice(0, 500)}`)
  }
  return decodeDeploymentFileBody(await res.text())
}
