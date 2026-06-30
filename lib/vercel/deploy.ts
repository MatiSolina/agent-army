/**
 * Pure, unit-testable helpers for the Vercel REST API deployer.
 * No I/O, no fetch, no env reads — only data transformations.
 */

// ---------------------------------------------------------------------------
// buildDeploymentFiles
// ---------------------------------------------------------------------------

export function buildDeploymentFiles(
  fileMap: Record<string, string>
): { file: string; data: string; encoding: "utf-8" }[] {
  return Object.entries(fileMap)
    .map(([file, data]) => ({ file, data, encoding: "utf-8" as const }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

// ---------------------------------------------------------------------------
// parseDeploymentResponse
// ---------------------------------------------------------------------------

export function parseDeploymentResponse(json: unknown): {
  id: string
  url: string
  readyState: string
  projectId: string | null
} {
  if (
    typeof json !== "object" ||
    json === null ||
    Array.isArray(json)
  ) {
    throw new Error("Unexpected Vercel API response")
  }
  const obj = json as Record<string, unknown>
  if (typeof obj.id !== "string" || typeof obj.readyState !== "string") {
    throw new Error("Unexpected Vercel API response")
  }
  const rawUrl = typeof obj.url === "string" ? obj.url : ""
  const url =
    rawUrl === "" || rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`
  // v13 deployment responses carry the owning project id, distinct from the
  // deployment id — persist THAT so it matches OTel spans' vercel.projectId.
  const projectId = typeof obj.projectId === "string" ? obj.projectId : null
  return { id: obj.id, url, readyState: obj.readyState, projectId }
}

// ---------------------------------------------------------------------------
// classifyReadyState
// ---------------------------------------------------------------------------

export function classifyReadyState(
  readyState: string
): "ready" | "error" | "pending" {
  const upper = readyState.toUpperCase()
  if (upper === "READY") return "ready"
  if (upper === "ERROR" || upper === "CANCELED" || upper === "BLOCKED")
    return "error"
  return "pending"
}

// ---------------------------------------------------------------------------
// extractBuildErrorText
// ---------------------------------------------------------------------------

const MAX_ERROR_TEXT = 1500

export function extractBuildErrorText(events: unknown): string {
  if (!Array.isArray(events)) return "(no build error output)"
  const lines: string[] = []
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue
    const obj = ev as Record<string, unknown>
    if (obj.type === "stderr" || obj.type === "fatal") {
      if (typeof obj.text === "string") lines.push(obj.text)
    }
  }
  if (lines.length === 0) return "(no build error output)"
  const joined = lines.join("\n")
  return joined.length > MAX_ERROR_TEXT
    ? joined.slice(0, MAX_ERROR_TEXT)
    : joined
}

// ---------------------------------------------------------------------------
// extractBuildLogLines — ordered, human-readable build log tail
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 200

/**
 * Turn the Vercel deployment events array into an ordered tail of build log
 * lines for the live redeploy modal. Unlike extractBuildErrorText (which keeps
 * only stderr/fatal), this keeps every text-bearing event in order so the user
 * sees the build as it streams. Trailing newlines are trimmed and blank lines
 * dropped; only the last MAX_LOG_LINES are kept so the polled payload stays
 * small. Non-array / malformed input yields [] (never throws).
 */
export function extractBuildLogLines(events: unknown): string[] {
  if (!Array.isArray(events)) return []
  const lines: string[] = []
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue
    const text = (ev as Record<string, unknown>).text
    if (typeof text !== "string") continue
    const trimmed = text.replace(/\s+$/, "")
    if (trimmed.length === 0) continue
    lines.push(trimmed)
  }
  return lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines
}

// ---------------------------------------------------------------------------
// summarizeDeployProgress — classify the newest deployment into a UI phase
// ---------------------------------------------------------------------------

export type DeployPhase = "preparing" | "building" | "ready" | "error"

export type DeployProgress = {
  phase: DeployPhase
  deploymentId: string | null
  url: string | null
  state: string | null
  createdAt: number | null
}

/**
 * Pick the in-flight deployment from a newest-first list and map its raw Vercel
 * readyState to a coarse UI phase for the redeploy modal.
 *
 * `sinceMs` is when the user clicked Deploy: any deployment older than that is a
 * PRIOR build, not this one, so until a newer deployment registers we report
 * "preparing" with a null id (the create call hasn't landed on Vercel yet).
 * QUEUED/INITIALIZING also map to "preparing" but DO expose the id (the build
 * exists, just hasn't started compiling). Pure — no I/O.
 */
export function summarizeDeployProgress(
  deployments: ReturnType<typeof parseDeploymentsList>,
  sinceMs: number,
): DeployProgress {
  const preparing: DeployProgress = {
    phase: "preparing",
    deploymentId: null,
    url: null,
    state: null,
    createdAt: null,
  }
  const newest = deployments[0]
  if (!newest || newest.createdAt < sinceMs) return preparing

  const base = {
    deploymentId: newest.id,
    url: newest.url,
    state: newest.state,
    createdAt: newest.createdAt,
  }
  const classification = classifyReadyState(newest.state)
  if (classification === "ready") return { ...base, phase: "ready" }
  if (classification === "error") return { ...base, phase: "error" }
  // pending: BUILDING means it's compiling; QUEUED/INITIALIZING are still setup.
  return {
    ...base,
    phase: newest.state === "BUILDING" ? "building" : "preparing",
  }
}

// ---------------------------------------------------------------------------
// parseEnvKeysResponse
// ---------------------------------------------------------------------------

/**
 * Parse the Vercel "list project env" response into a keys-only view.
 *
 * Accepts either `{ envs: [...] }` or a bare array. For each entry we surface
 * ONLY `{ key, target, type }` — the `value` field (masked when `decrypt` is
 * unset, but still server-side data) is deliberately dropped so a secret value
 * can never travel further than the Vercel API boundary. Unexpected input
 * yields `[]` (defensive: never throws on shape).
 */
export function parseEnvKeysResponse(json: unknown): {
  key: string
  target: string[]
  type: string
}[] {
  const rawList: unknown = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? (json as Record<string, unknown>).envs
      : undefined
  if (!Array.isArray(rawList)) return []

  const out: { key: string; target: string[]; type: string }[] = []
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue
    const obj = entry as Record<string, unknown>
    if (typeof obj.key !== "string") continue
    const target = Array.isArray(obj.target)
      ? obj.target.filter((t): t is string => typeof t === "string")
      : typeof obj.target === "string"
        ? [obj.target]
        : []
    const type = typeof obj.type === "string" ? obj.type : ""
    out.push({ key: obj.key, target, type })
  }
  return out
}

// ---------------------------------------------------------------------------
// parseDeploymentsList
// ---------------------------------------------------------------------------

/**
 * Parse the Vercel GET /v6/deployments response
 * (`{ deployments: [{ uid, url, created, state|readyState, target }] }`) into a
 * flat list for the Deployments tab. `id` comes from `uid`, `state` from
 * `state ?? readyState`, `createdAt` from `created`, and `target` from
 * `target ?? null` (preview deploys have a null target). Entries without a
 * string `uid` are skipped; unexpected input yields `[]` (never throws).
 */
export function parseDeploymentsList(json: unknown): {
  id: string
  url: string
  state: string
  createdAt: number
  target: string | null
}[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return []
  }
  const rawList = (json as Record<string, unknown>).deployments
  if (!Array.isArray(rawList)) return []

  const out: {
    id: string
    url: string
    state: string
    createdAt: number
    target: string | null
  }[] = []
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue
    const obj = entry as Record<string, unknown>
    if (typeof obj.uid !== "string") continue
    const url = typeof obj.url === "string" ? obj.url : ""
    const state =
      typeof obj.state === "string"
        ? obj.state
        : typeof obj.readyState === "string"
          ? obj.readyState
          : ""
    const createdAt = typeof obj.created === "number" ? obj.created : 0
    const target = typeof obj.target === "string" ? obj.target : null
    out.push({ id: obj.uid, url, state, createdAt, target })
  }
  return out
}

// ---------------------------------------------------------------------------
// parseProductionDeploymentId
// ---------------------------------------------------------------------------

/**
 * From the Vercel GET /v9/projects/{slug} response, return the id of the
 * deployment currently live on production (`targets.production.id`) when it is
 * a string, else `null` (project never promoted, or unexpected shape).
 */
export function parseProductionDeploymentId(json: unknown): string | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return null
  }
  const targets = (json as Record<string, unknown>).targets
  if (typeof targets !== "object" || targets === null) return null
  const production = (targets as Record<string, unknown>).production
  if (typeof production !== "object" || production === null) return null
  const id = (production as Record<string, unknown>).id
  return typeof id === "string" ? id : null
}

// ---------------------------------------------------------------------------
// parseProjectsList — list the team's projects (for the import picker)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export type ProjectSummary = {
  id: string
  name: string
  framework: string | null
  productionDeploymentId: string | null
}

/**
 * Parse GET /v10/projects. The endpoint is a `oneOf`: a BARE ARRAY of project
 * objects, OR `{ projects: [...], pagination: { next } }`. Read each project's
 * id/name/framework and resolve its current production deployment id from
 * `targets.production.id` (reusing the same path as parseProductionDeploymentId)
 * so the picker needs no per-project follow-up call. `next` is the pagination
 * continuation token (passed back as `from`), or null on the last page.
 */
export function parseProjectsList(json: unknown): {
  projects: ProjectSummary[]
  next: string | null
} {
  const rawList = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.projects)
      ? json.projects
      : []
  const pagination = isRecord(json) ? json.pagination : null
  const nextRaw = isRecord(pagination) ? pagination.next : null
  const next =
    typeof nextRaw === "string"
      ? nextRaw
      : typeof nextRaw === "number"
        ? String(nextRaw)
        : null

  const projects: ProjectSummary[] = []
  for (const p of rawList) {
    if (!isRecord(p)) continue
    if (typeof p.id !== "string" || typeof p.name !== "string") continue
    projects.push({
      id: p.id,
      name: p.name,
      framework: typeof p.framework === "string" ? p.framework : null,
      productionDeploymentId: parseProductionDeploymentId(p),
    })
  }
  return { projects, next }
}

// ---------------------------------------------------------------------------
// flattenDeploymentFiles — recursive source tree → flat {path, uid} list
// ---------------------------------------------------------------------------

export type DeploymentFileEntry = { path: string; uid: string }

/**
 * Flatten GET /v6/deployments/{id}/files (a recursive tree) into the readable
 * SOURCE files only. Each node is `{ name, type, uid?, children? }`; directories
 * carry `children` (recurse, joining `name` segments with "/"), files carry a
 * `uid` (the fileId for the contents endpoint). Build-output artifacts come back
 * as `type:"lambda"|"middleware"` (no readable uid) — only `type:"file"` leaves
 * are kept. Tolerates a bare array OR `{ files: [...] }` at the top.
 */
export function flattenDeploymentFiles(json: unknown): DeploymentFileEntry[] {
  const roots = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json.files)
      ? json.files
      : []
  const out: DeploymentFileEntry[] = []
  const walk = (nodes: unknown[], prefix: string) => {
    for (const node of nodes) {
      if (!isRecord(node)) continue
      const name = typeof node.name === "string" ? node.name : ""
      const path = prefix ? `${prefix}/${name}` : name
      if (node.type === "directory" && Array.isArray(node.children)) {
        walk(node.children, path)
      } else if (node.type === "file" && typeof node.uid === "string") {
        out.push({ path, uid: node.uid })
      }
    }
  }
  walk(roots, "")
  return out
}

// ---------------------------------------------------------------------------
// decodeDeploymentFileBody — normalize the file-contents response to text
// ---------------------------------------------------------------------------

/**
 * Normalize the GET /v8/deployments/{id}/files/{fileId} body to the file's text.
 * VERIFIED shape (real eve deployment): `{"data":"<base64>"}`. Handled
 * defensively because the endpoint is documented loosely: try JSON-parse →
 * pull `data`/`content`; if the value still looks like base64 (and round-trips),
 * decode it; otherwise return the raw body as-is (some files come back as plain
 * text). note: the base64 round-trip guard avoids mis-decoding plain text
 * that happens to be base64-shaped; a pathological all-base64-charset source
 * file is the known ceiling.
 */
export function decodeDeploymentFileBody(raw: string): string {
  let candidate = raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) {
      const d = parsed.data ?? parsed.content
      if (typeof d === "string") candidate = d
    } else if (typeof parsed === "string") {
      candidate = parsed
    }
  } catch {
    // Not JSON — the raw body is the file text (or bare base64, handled below).
  }
  const compact = candidate.replace(/\s/g, "")
  if (
    compact.length > 0 &&
    compact.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf-8")
      if (Buffer.from(decoded, "utf-8").toString("base64") === compact) {
        return decoded
      }
    } catch {
      // fall through to returning the candidate verbatim
    }
  }
  return candidate
}
