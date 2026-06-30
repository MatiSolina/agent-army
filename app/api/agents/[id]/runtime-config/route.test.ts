import { describe, it, expect, beforeEach, vi } from "vitest"

let rows: Array<{ systemPrompt: string; updatedAt: Date | null }> = []

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  },
}))

import { GET } from "./route"
import { agentToken } from "@/lib/eve/agent-token"

const FM_KEY = "fm-agent-key"
const tok = (id: string) => agentToken(id, FM_KEY)

function makeReq(auth?: string) {
  const headers: Record<string, string> = {}
  if (auth != null) headers.authorization = auth
  return new Request("https://fm.test/api/agents/agent-1/runtime-config", {
    headers,
  }) as unknown as Parameters<typeof GET>[0]
}

describe("GET /api/agents/[id]/runtime-config", () => {
  beforeEach(() => {
    process.env.FM_AGENT_KEY = FM_KEY
    process.env.EVE_API_SECRET = "legacy-shared-secret"
    rows = [{ systemPrompt: "Runtime prompt B", updatedAt: new Date("2026-06-28T12:00:00.000Z") }]
  })

  it("401s without a bearer", async () => {
    const res = await GET(makeReq(), { params: Promise.resolve({ id: "agent-1" }) })
    expect(res.status).toBe(401)
  })

  it("401s on a garbage bearer", async () => {
    const res = await GET(makeReq("Bearer wrong"), { params: Promise.resolve({ id: "agent-1" }) })
    expect(res.status).toBe(401)
  })

  it("401s on the legacy shared EVE_API_SECRET (clean cut — no fallback)", async () => {
    const res = await GET(makeReq("Bearer legacy-shared-secret"), {
      params: Promise.resolve({ id: "agent-1" }),
    })
    expect(res.status).toBe(401)
  })

  it("200 with this agent's own per-agent token", async () => {
    const res = await GET(makeReq(`Bearer ${tok("agent-1")}`), {
      params: Promise.resolve({ id: "agent-1" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      systemPrompt: "Runtime prompt B",
      revision: "2026-06-28T12:00:00.000Z",
    })
  })

  it("401 when the token belongs to a DIFFERENT agent (cross-agent read blocked)", async () => {
    const res = await GET(makeReq(`Bearer ${tok("agent-2")}`), {
      params: Promise.resolve({ id: "agent-1" }),
    })
    expect(res.status).toBe(401)
  })

  it("404 when the agent does not exist (valid token, no row)", async () => {
    rows = []
    const res = await GET(makeReq(`Bearer ${tok("missing")}`), {
      params: Promise.resolve({ id: "missing" }),
    })
    expect(res.status).toBe(404)
  })
})
