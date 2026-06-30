import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Mock the broker helper so the route is tested in isolation (no DB / network).
vi.mock("@/lib/mcp/get-fresh-token", () => ({
  getFreshAccessToken: vi.fn(),
}))
// Mock the agent-row read used by the per-agent (&agent=) scope check.
let dbRows: Array<{ id: string; connectionIds: string[] }> = []
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => dbRows }) }) },
}))
vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => a }))

import { GET } from "./route"
import { getFreshAccessToken } from "@/lib/mcp/get-fresh-token"
import { agentToken } from "@/lib/eve/agent-token"

const mockGetFresh = vi.mocked(getFreshAccessToken)

const FM_KEY = "fm-agent-key"
const A = `Bearer ${agentToken("A", FM_KEY)}` // agent A's per-agent token

function makeReq(opts: { auth?: string; conn?: string; agent?: string }) {
  let url = "https://fm.test/api/mcp/token"
  const qs: string[] = []
  if (opts.conn) qs.push(`conn=${encodeURIComponent(opts.conn)}`)
  if (opts.agent) qs.push(`agent=${encodeURIComponent(opts.agent)}`)
  if (qs.length) url += `?${qs.join("&")}`
  const headers: Record<string, string> = {}
  if (opts.auth != null) headers["authorization"] = opts.auth
  return new Request(url, { headers }) as unknown as Parameters<typeof GET>[0]
}

describe("GET /api/mcp/token (M2M token broker)", () => {
  beforeEach(() => {
    process.env.FM_AGENT_KEY = FM_KEY
    process.env.EVE_API_SECRET = "legacy-shared-secret"
    dbRows = [{ id: "A", connectionIds: ["c1"] }]
    mockGetFresh.mockReset()
  })

  describe("auth guard", () => {
    it("400 with no Authorization header (missing &agent path still validates conn+agent)", async () => {
      const res = await GET(makeReq({ conn: "c1", agent: "A" }))
      // no bearer → 401 (agent present, conn present)
      expect(res.status).toBe(401)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })

    it("401 on a garbage bearer", async () => {
      const res = await GET(makeReq({ auth: "Bearer wrong", conn: "c1", agent: "A" }))
      expect(res.status).toBe(401)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })

    it("401 on the legacy shared secret (clean cut — no fallback)", async () => {
      const res = await GET(makeReq({ auth: "Bearer legacy-shared-secret", conn: "c1", agent: "A" }))
      expect(res.status).toBe(401)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })
  })

  describe("request validation", () => {
    it("400 when ?conn is missing", async () => {
      const res = await GET(makeReq({ auth: A, agent: "A" }))
      expect(res.status).toBe(400)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })

    it("400 when ?agent is missing (required now)", async () => {
      const res = await GET(makeReq({ auth: A, conn: "c1" }))
      expect(res.status).toBe(400)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })
  })

  describe("success", () => {
    it("200 with {token,expiresAt} when the broker resolves a token", async () => {
      mockGetFresh.mockResolvedValue({ token: "AT", expiresAt: 123 })
      const res = await GET(makeReq({ auth: A, conn: "c1", agent: "A" }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ token: "AT", expiresAt: 123 })
      expect(mockGetFresh).toHaveBeenCalledWith("c1")
    })

    it("200 with just {token} when no expiry is known", async () => {
      mockGetFresh.mockResolvedValue({ token: "AT" })
      const res = await GET(makeReq({ auth: A, conn: "c1", agent: "A" }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ token: "AT" })
    })
  })

  describe("error mapping", () => {
    it("409 when the broker reports a needs-reconnect condition", async () => {
      mockGetFresh.mockRejectedValue(new Error("no token: needs reconnect"))
      const res = await GET(makeReq({ auth: A, conn: "c1", agent: "A" }))
      expect(res.status).toBe(409)
    })

    it("502 on any other (refresh / network) failure", async () => {
      mockGetFresh.mockRejectedValue(new Error("boom"))
      const res = await GET(makeReq({ auth: A, conn: "c1", agent: "A" }))
      expect(res.status).toBe(502)
    })
  })

  describe("token redaction", () => {
    let logSpy: ReturnType<typeof vi.spyOn>
    let errSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    })
    afterEach(() => {
      logSpy.mockRestore()
      errSpy.mockRestore()
    })

    it("never logs the resolved token", async () => {
      mockGetFresh.mockResolvedValue({ token: "SUPER-SECRET-TOKEN", expiresAt: 9 })
      await GET(makeReq({ auth: A, conn: "c1", agent: "A" }))
      const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
        .flat()
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")
      expect(logged).not.toContain("SUPER-SECRET-TOKEN")
    })
  })

  describe("per-agent scope (&agent=)", () => {
    it("200 when agent A's token requests A's own connection", async () => {
      mockGetFresh.mockResolvedValue({ token: "AT", expiresAt: 1 })
      const res = await GET(
        makeReq({ auth: `Bearer ${agentToken("A", FM_KEY)}`, conn: "c1", agent: "A" }),
      )
      expect(res.status).toBe(200)
      expect(mockGetFresh).toHaveBeenCalledWith("c1")
    })

    it("403 when the connection is NOT in the agent's connectionIds", async () => {
      const res = await GET(
        makeReq({ auth: `Bearer ${agentToken("A", FM_KEY)}`, conn: "c2", agent: "A" }),
      )
      expect(res.status).toBe(403)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })

    it("401 when the bearer is another agent's token", async () => {
      const res = await GET(
        makeReq({ auth: `Bearer ${agentToken("B", FM_KEY)}`, conn: "c1", agent: "A" }),
      )
      expect(res.status).toBe(401)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })

    it("403 when agent B brokers a connection that belongs to A", async () => {
      // B authenticates fine for itself, but c1 is A's connection, not B's.
      dbRows = [{ id: "B", connectionIds: ["cB"] }]
      const res = await GET(
        makeReq({ auth: `Bearer ${agentToken("B", FM_KEY)}`, conn: "c1", agent: "B" }),
      )
      expect(res.status).toBe(403)
      expect(mockGetFresh).not.toHaveBeenCalled()
    })
  })
})
