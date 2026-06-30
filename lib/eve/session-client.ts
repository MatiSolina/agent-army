// session-client — server-side proxy to a DEPLOYED Eve agent's HTTP API.
//
// Every deployed Eve project exposes a default HTTP API at /eve/v1/session*
// (no generated file needed). Its auth is [localDev(), vercelOidc()]: browsers
// are NOT admitted in prod, but other Vercel deployments from the same team ARE
// via OIDC. The dashboard runs on Vercel with VERCEL_OIDC_TOKEN injected, so it
// acts as the authenticated server-side proxy. We reuse the Bearer-token pattern
// from app/actions/skills.ts authHeaders().
//
// Wire contract (Eve default /eve/v1/session*, see eve docs
// concepts/sessions-runs-and-streaming):
//   - Start:     POST `${base}/eve/v1/session`            body {message}
//                  -> {sessionId, continuationToken, ok}
//   - Follow-up: POST `${base}/eve/v1/session/${sessionId}`
//                  body {continuationToken, message}      (token is REQUIRED)
//   - Stream:    GET  `${base}/eve/v1/session/${sessionId}/stream` -> NDJSON,
//                  one `{type, data}` event per line.
//   - Auth:      Authorization: Bearer ${VERCEL_OIDC_TOKEN}  (cross-deployment OIDC)
//
// The final assistant text is on the `message.completed` event whose
// `data.finishReason !== "tool-calls"`; a "tool-calls" turn is interim tool-call
// narration and is skipped. The turn ends at a boundary event (session.waiting /
// session.completed / session.failed).
//
// note: this is a MANUAL fetch + line-by-line NDJSON parse, deliberately not
// the `eve` npm package (not installed; the dashboard runs Node 22 and cannot run
// the eve CLI). The wire contract above is small and stable, so a hand-rolled
// reader is the right ceiling here. If reconnect/cursor robustness (resuming a
// dropped stream, deduping by event index) is ever needed, switch to the
// eve/client SDK: `Client.session().send().result()`.

type SendArgs = {
  /** The deployed agent's base URL (agent.deploymentUrl). Trailing slashes are stripped. */
  baseUrl: string
  /** The user's message for this turn. */
  message: string
  /** When set, posts a follow-up turn to an existing session instead of starting a new one. */
  sessionId?: string
  /** Required for follow-up turns: the resume handle from the previous turn. */
  continuationToken?: string
  /**
   * Event cursor from the previous turn. The eve stream is durable and replays
   * from index 0, so a follow-up MUST resume past the already-consumed events
   * (`?startIndex=`) — otherwise it stops at turn 1's session.waiting and serves
   * that turn's stale reply for every subsequent message.
   */
  startIndex?: number
}

type SendResult = {
  /** The final assistant text (terminal reply, never tool-call narration). */
  text: string
  /** The session id to reuse for the next turn's stream. */
  sessionId: string
  /** The resume handle to send with the next follow-up turn. */
  continuationToken?: string
  /** Event cursor to pass as the next turn's `startIndex` (durable-stream resume). */
  startIndex: number
}

function authHeaders(): HeadersInit {
  // The agent's eve channel authenticates this proxy with a shared secret
  // (EVE_API_SECRET). VERCEL_OIDC_TOKEN is NOT populated as an env var in a
  // serverless runtime (it arrives as a request header), and same-team OIDC is
  // cross-project here anyway, so a shared secret is the reliable path.
  const token = process.env.EVE_API_SECRET || process.env.VERCEL_OIDC_TOKEN
  return {
    "Content-Type": "application/json",
    Accept: "application/x-ndjson",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/**
 * Guard the outbound base URL before we attach the Bearer OIDC token.
 *
 * The token is a real credential, so we must not send it to an arbitrary host
 * (SSRF / credential-leak). Deployed Eve agents live on `*.vercel.app` over
 * https; reject anything else.
 *
 * note: `*.vercel.app` is the only host we deploy to today. If custom
 * production domains are ever added to a deployment, widen this allowlist.
 */
function assertSafeBaseUrl(baseUrl: string): URL {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error("Deployed agent URL is not a valid URL")
  }
  if (url.protocol !== "https:") {
    throw new Error("Deployed agent URL must be https")
  }
  if (url.hostname !== "vercel.app" && !url.hostname.endsWith(".vercel.app")) {
    throw new Error("Deployed agent URL must be a *.vercel.app host")
  }
  return url
}

/**
 * Send one chat turn to a deployed Eve agent and return its final assistant text.
 *
 * Starts a new session (POST /eve/v1/session) when no `sessionId` is given, or
 * posts a follow-up turn (POST /eve/v1/session/${sessionId} with the stored
 * continuation token) when one is. Then reads the session stream and returns the
 * terminal assistant reply plus the handles for the next turn.
 *
 * Throws (surfacing the HTTP status) on any non-2xx response.
 */
export async function sendToDeployedAgent({
  baseUrl,
  message,
  sessionId,
  continuationToken,
  startIndex,
}: SendArgs): Promise<SendResult> {
  const base = assertSafeBaseUrl(baseUrl.trim().replace(/\/+$/, "")).toString().replace(/\/+$/, "")

  const postUrl = sessionId
    ? `${base}/eve/v1/session/${sessionId}`
    : `${base}/eve/v1/session`

  // Follow-up turns MUST carry the continuation token; a fresh session must not.
  const body = sessionId
    ? JSON.stringify({ continuationToken, message })
    : JSON.stringify({ message })

  const postRes = await fetch(postUrl, {
    method: "POST",
    headers: authHeaders(),
    body,
  })
  if (!postRes.ok) {
    throw new Error(`Deployed agent session request failed (${postRes.status})`)
  }

  // A fresh session returns its sessionId + continuationToken in the POST body;
  // a follow-up reuses the passed-in sessionId and may rotate the token.
  let resolvedSessionId = sessionId ?? ""
  let resolvedToken = continuationToken
  try {
    const startJson = (await postRes.json()) as {
      sessionId?: string
      continuationToken?: string
    }
    if (startJson.sessionId) resolvedSessionId = startJson.sessionId
    if (startJson.continuationToken) resolvedToken = startJson.continuationToken
  } catch {
    // No JSON body — keep the passed-in handles (some follow-up responses).
  }

  if (!resolvedSessionId) {
    throw new Error("Deployed agent did not return a session id")
  }

  // The eve session stream is DURABLE: it stays open after the turn
  // (session.waiting) waiting for the next message. We must stop reading at the
  // turn boundary and tear the socket down WITHOUT awaiting reader.cancel() — on
  // serverless runtimes cancelling a still-open upstream stream can hang. An
  // AbortController gives us a hard stop plus a safety timeout.
  const resumeFrom = startIndex ?? 0
  const ac = new AbortController()
  const streamUrl =
    `${base}/eve/v1/session/${resolvedSessionId}/stream` +
    (resumeFrom > 0 ? `?startIndex=${resumeFrom}` : "")
  const streamRes = await fetch(streamUrl, {
    method: "GET",
    headers: authHeaders(),
    signal: ac.signal,
  })
  if (!streamRes.ok) {
    throw new Error(`Deployed agent stream request failed (${streamRes.status})`)
  }

  const { text, consumed } = await readFinalText(streamRes, ac)

  return {
    text,
    sessionId: resolvedSessionId,
    continuationToken: resolvedToken,
    startIndex: resumeFrom + consumed,
  }
}

type StreamEvent = {
  type?: string
  data?: {
    finishReason?: string
    message?: unknown
    // session.failed / turn.failed / step.failed carry the real error here.
    code?: string
    details?: { message?: string }
    // authorization.required carries the connection/tool name + the consent
    // challenge (Vercel Connect / interactive OAuth sign-in URL).
    name?: string
    authorization?: { url?: string; userCode?: string }
  }
}

/**
 * Human-readable reason from a `session.failed` event. The runtime puts the
 * actual error (e.g. "Free tier users do not have access to this model") on
 * `data.details.message`, with a machine code on `data.code`. Surface both so
 * the tester sees what really happened instead of a generic string.
 */
function failureMessage(ev: StreamEvent): string {
  const detail = ev.data?.details?.message
  const code = ev.data?.code
  if (detail) return code ? `${code}: ${detail}` : detail
  if (code) return code
  return "Deployed agent session failed"
}

const BOUNDARY = new Set(["session.waiting", "session.completed", "session.failed"])

/**
 * Read the NDJSON event stream line by line and return the FINAL assistant text.
 *
 * Reads incrementally and stops at the first turn boundary (session.waiting /
 * session.completed / session.failed) rather than waiting for EOF — the durable
 * stream can stay open past the turn. The last `message.completed` whose
 * finishReason is not "tool-calls" wins (earlier ones are tool-call narration).
 * `session.failed` throws so the tester sees an error instead of an empty reply.
 */
async function readFinalText(
  res: Response,
  ac: AbortController,
): Promise<{ text: string; consumed: number }> {
  const reader = res.body?.getReader()
  // No streaming body (shouldn't happen for the stream route) — fall back to text.
  if (!reader) return finalTextFromLines((await res.text()).split("\n"))

  const decoder = new TextDecoder()
  let buffer = ""
  let finalText = ""
  // A pending OAuth/Vercel-Connect consent prompt (authorization.required). When
  // the turn parks on sign-in there's no assistant text, so we surface this URL
  // as the reply so the tester can complete the connection.
  let authPrompt = ""
  // Count every event we consume; the caller adds this to its cursor so the
  // next turn resumes past it (durable stream replays from index 0).
  let consumed = 0

  // Safety net: never let a durable stream pin the function open. Abort after
  // 60s; the read loop's catch returns whatever text we captured.
  const timeout = setTimeout(() => ac.abort(), 60_000)

  // Stop reading at the turn boundary. We abort() the fetch (hard socket close)
  // instead of awaiting reader.cancel(), which can hang on an open upstream.
  const stopAt = (): { text: string; consumed: number } => {
    clearTimeout(timeout)
    ac.abort()
    return { text: finalText || authPrompt, consumed }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const ev = parseEvent(line)
        if (!ev) continue
        consumed++
        if (ev.type === "session.failed") {
          stopAt()
          throw new Error(failureMessage(ev))
        }
        if (ev.type === "authorization.required") {
          const url = ev.data?.authorization?.url
          if (url) {
            const who = ev.data?.name ?? "connection"
            const code = ev.data?.authorization?.userCode
            authPrompt =
              `🔗 Authorize "${who}" to continue: ${url}` +
              (code ? ` (code: ${code})` : "")
          }
        }
        const t = terminalText(ev)
        if (t != null) finalText = t
        if (ev.type && BOUNDARY.has(ev.type)) {
          return stopAt()
        }
      }
    }
  } catch (err) {
    // AbortError (our own abort/timeout) → return what we have; rethrow others.
    if (!(err instanceof Error) || err.name !== "AbortError") {
      clearTimeout(timeout)
      throw err
    }
  }
  clearTimeout(timeout)

  // Stream ended without an explicit boundary — use whatever's buffered.
  if (buffer.trim()) {
    const ev = parseEvent(buffer)
    if (ev) {
      consumed++
      const t = terminalText(ev)
      if (t != null) finalText = t
    }
  }
  return { text: finalText || authPrompt, consumed }
}

function parseEvent(line: string): StreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as StreamEvent
  } catch {
    return null
  }
}

/** Text of a terminal `message.completed` event, or null if not one. */
function terminalText(ev: StreamEvent): string | null {
  if (ev.type !== "message.completed") return null
  if (ev.data?.finishReason === "tool-calls") return null
  const msg = ev.data?.message
  return typeof msg === "string" ? msg : ""
}

function finalTextFromLines(lines: string[]): { text: string; consumed: number } {
  let finalText = ""
  let consumed = 0
  for (const line of lines) {
    const ev = parseEvent(line)
    if (!ev) continue
    consumed++
    const t = terminalText(ev)
    if (t != null) finalText = t
  }
  return { text: finalText, consumed }
}
