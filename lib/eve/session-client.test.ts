import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { sendToDeployedAgent } from "./session-client"

// ---------------------------------------------------------------------------
// session-client: server-side proxy to a DEPLOYED Eve agent's HTTP API.
//
// Wire contract (Eve default /eve/v1/session*):
//   - Start:    POST `${base}/eve/v1/session`            body {message}
//                 -> {sessionId, continuationToken, ok}
//   - Follow-up POST `${base}/eve/v1/session/${sessionId}` body {continuationToken, message}
//   - Stream:   GET  `${base}/eve/v1/session/${sessionId}/stream` -> NDJSON
//   - Auth:     Authorization: Bearer ${VERCEL_OIDC_TOKEN}  (cross-deployment OIDC)
//
// NDJSON events are `{type, data}`. The final assistant text is on the
// `message.completed` event whose `data.finishReason !== "tool-calls"`; a
// "tool-calls" turn is interim narration and must be ignored. The turn ends at a
// boundary event (session.waiting / session.completed / session.failed).
//
// fetch is mocked: real reachability of the live Vercel agent can only be
// verified at runtime (OIDC cross-deployment auth), not from this test.
// ---------------------------------------------------------------------------

const BASE = "https://my-agent.vercel.app"
const SESSION_ID = "sess_abc123"
const TOKEN = "eve:token-1"

/** Build a Response whose body streams the given lines as NDJSON. */
function ndjsonResponse(lines: string[]): Response {
  const body = lines.join("\n") + "\n"
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  })
}

/** A realistic two-turn stream: an interim tool-call narration, then the
 * terminal assistant reply. The first `message.completed` is a tool-calls
 * turn (must be ignored); the second is the terminal `end_turn` reply. */
const STREAM_LINES = [
  JSON.stringify({ type: "session.started" }),
  JSON.stringify({
    type: "message.completed",
    data: { finishReason: "tool-calls", message: "Let me look that up." },
  }),
  JSON.stringify({
    type: "message.completed",
    data: { finishReason: "end_turn", message: "The answer is 42." },
  }),
  JSON.stringify({ type: "session.waiting" }),
]

beforeEach(() => {
  process.env.VERCEL_OIDC_TOKEN = "test-oidc-token"
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("sendToDeployedAgent", () => {
  it("starts a new session: POSTs {message} to /eve/v1/session with a Bearer OIDC header (trailing slash stripped)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sessionId: SESSION_ID, continuationToken: TOKEN, ok: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(ndjsonResponse(STREAM_LINES))
    vi.stubGlobal("fetch", fetchMock)

    const out = await sendToDeployedAgent({
      baseUrl: `${BASE}/`, // trailing slash must be stripped
      message: "What is the answer?",
    })

    // First call = session POST.
    const [postUrl, postInit] = fetchMock.mock.calls[0]
    expect(postUrl).toBe(`${BASE}/eve/v1/session`)
    expect(postInit.method).toBe("POST")
    const headers = new Headers(postInit.headers)
    expect(headers.get("authorization")).toBe("Bearer test-oidc-token")
    expect(JSON.parse(postInit.body as string)).toMatchObject({
      message: "What is the answer?",
    })

    // The continuation token is surfaced for the next turn.
    expect(out.sessionId).toBe(SESSION_ID)
    expect(out.continuationToken).toBe(TOKEN)
  })

  it("posts the follow-up turn to /eve/v1/session/${sessionId} with the continuation token (no new session)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(ndjsonResponse(STREAM_LINES))
    vi.stubGlobal("fetch", fetchMock)

    const out = await sendToDeployedAgent({
      baseUrl: BASE,
      message: "And again?",
      sessionId: SESSION_ID,
      continuationToken: TOKEN,
    })

    const [postUrl, postInit] = fetchMock.mock.calls[0]
    expect(postUrl).toBe(`${BASE}/eve/v1/session/${SESSION_ID}`)
    expect(postInit.method).toBe("POST")
    // Eve requires the continuation token on follow-ups.
    expect(JSON.parse(postInit.body as string)).toMatchObject({
      continuationToken: TOKEN,
      message: "And again?",
    })
    // Re-uses the same session id rather than starting a fresh one.
    expect(out.sessionId).toBe(SESSION_ID)
  })

  it("rejects a non-vercel.app base URL (does not leak the OIDC token)", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      sendToDeployedAgent({ baseUrl: "https://evil.example.com", message: "hi" }),
    ).rejects.toThrow(/vercel\.app/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns the FINAL assistant text, ignoring interim tool-call narration", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: SESSION_ID, ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(ndjsonResponse(STREAM_LINES))
    vi.stubGlobal("fetch", fetchMock)

    const out = await sendToDeployedAgent({
      baseUrl: BASE,
      message: "What is the answer?",
    })

    expect(out.text).toBe("The answer is 42.")
    expect(out.text).not.toContain("Let me look that up.")
  })

  it("surfaces a startIndex cursor advanced by the number of stream events consumed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: SESSION_ID, ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(ndjsonResponse(STREAM_LINES))
    vi.stubGlobal("fetch", fetchMock)

    const out = await sendToDeployedAgent({ baseUrl: BASE, message: "hi" })

    // STREAM_LINES has 4 events; the next turn must resume after them so the
    // durable replay does not re-serve this turn's reply.
    expect(out.startIndex).toBe(STREAM_LINES.length)
  })

  it("follow-up requests the stream from the stored startIndex (skips replayed history)", async () => {
    // The durable stream replays turn 1 (4 events) THEN turn 2. Without the
    // cursor we'd stop at turn 1's session.waiting and return its stale reply.
    const replay = [
      ...STREAM_LINES, // turn 1: ends "The answer is 42." + session.waiting
      JSON.stringify({
        type: "message.completed",
        data: { finishReason: "end_turn", message: "Second turn reply." },
      }),
      JSON.stringify({ type: "session.waiting" }),
    ]
    // With startIndex=4 the server only sends turn 2's events.
    const turn2Only = replay.slice(STREAM_LINES.length)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(ndjsonResponse(turn2Only))
    vi.stubGlobal("fetch", fetchMock)

    const out = await sendToDeployedAgent({
      baseUrl: BASE,
      message: "And again?",
      sessionId: SESSION_ID,
      continuationToken: TOKEN,
      startIndex: STREAM_LINES.length,
    })

    const [streamUrl] = fetchMock.mock.calls[1]
    expect(streamUrl).toBe(
      `${BASE}/eve/v1/session/${SESSION_ID}/stream?startIndex=${STREAM_LINES.length}`,
    )
    expect(out.text).toBe("Second turn reply.")
    expect(out.startIndex).toBe(replay.length)
  })

  it("surfaces the Vercel Connect consent URL from an authorization.required event", async () => {
    // When a connection needs OAuth (e.g. Slack via Vercel Connect), eve emits
    // authorization.required with the consent URL; the tester must see a link.
    const authLines = [
      JSON.stringify({ type: "session.started" }),
      JSON.stringify({
        type: "authorization.required",
        data: {
          name: "slack",
          authorization: { url: "https://connect.vercel.com/consent/abc123" },
        },
      }),
      JSON.stringify({ type: "session.waiting" }),
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: SESSION_ID, ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(ndjsonResponse(authLines))
    vi.stubGlobal("fetch", fetchMock)

    const out = await sendToDeployedAgent({ baseUrl: BASE, message: "post to slack" })
    expect(out.text).toContain("https://connect.vercel.com/consent/abc123")
    expect(out.text.toLowerCase()).toContain("slack")
  })

  it("surfaces the real failure reason from a session.failed event (code + message), not a generic string", async () => {
    const failLines = [
      JSON.stringify({ type: "session.started" }),
      JSON.stringify({
        type: "session.failed",
        data: {
          code: "MODEL_CALL_FAILED",
          details: {
            message:
              "GatewayInternalServerError: Free tier users do not have access to this model.",
          },
        },
      }),
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: SESSION_ID, ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(ndjsonResponse(failLines))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      sendToDeployedAgent({ baseUrl: BASE, message: "hi" }),
    ).rejects.toThrow(/MODEL_CALL_FAILED.*Free tier users do not have access/)
  })

  it("throws (surfacing the status) when the session POST is not 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("forbidden", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      sendToDeployedAgent({ baseUrl: BASE, message: "hello" }),
    ).rejects.toThrow(/403/)
  })
})
