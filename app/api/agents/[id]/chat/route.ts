import { getAgent } from "@/app/actions/agents"
import { sendToDeployedAgent } from "@/lib/eve/session-client"
import { getSessionUser } from "@/lib/session"
import { rateLimitOk } from "@/lib/rate-limit"

// Each call invokes the agent's deployed runtime (real AI spend). Bound it per
// operator+agent and cap message length, so the Test tab can't be driven into
// runaway cost.
const CHAT_RATE = { limit: 30, windowSeconds: 60 }
const MAX_MESSAGE_CHARS = 20_000

// Browser chat endpoint for the agent editor's "Test" tab. The reply comes from
// the agent's REAL deployed Eve project on Vercel via lib/eve/session-client.
// We return the final reply as JSON synchronously (await the deployed run) so the
// client renders it — no async/background posting that races the response close.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return new Response("Unauthorized", { status: 401 })

  const { id } = await params
  const agent = await getAgent(id)
  if (!agent) return new Response("Agent not found", { status: 404 })
  if (!agent.enabled) return new Response("Agent is disabled", { status: 403 })

  if (!(await rateLimitOk(`chat:${user.id}:${id}`, CHAT_RATE.limit, CHAT_RATE.windowSeconds))) {
    return Response.json({ error: "Too many requests — slow down." }, { status: 429 })
  }

  let body: {
    message?: string
    sessionId?: string
    continuationToken?: string
    startIndex?: number
    preview?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 })
  }

  // Resolve the target URL from the AGENT ROW only — never from the client.
  // `preview: true` tests the latest preview build (allowed while it is
  // preview_ready OR already deployed); otherwise we hit the live production
  // runtime. The client only sends a boolean, so there is no SSRF surface.
  let targetUrl: string
  if (body.preview === true) {
    if (!agent.previewUrl) {
      return Response.json({ error: "No preview to test" }, { status: 400 })
    }
    targetUrl = agent.previewUrl
  } else {
    if (agent.deploymentStatus !== "deployed" || !agent.deploymentUrl) {
      return Response.json(
        {
          error: "Deploy this agent first to test it against the live runtime.",
        },
        { status: 409 },
      )
    }
    targetUrl = agent.deploymentUrl
  }

  const message = body.message?.trim()
  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400 })
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return Response.json({ error: "Message is too long" }, { status: 413 })
  }

  try {
    const result = await sendToDeployedAgent({
      baseUrl: targetUrl,
      message,
      sessionId: body.sessionId,
      continuationToken: body.continuationToken,
      startIndex: body.startIndex,
    })
    return Response.json(result)
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Agent request failed" },
      { status: 502 },
    )
  }
}
