import { describe, it, expect } from "vitest"
import { findTraceDrain, ensureTraceDrain } from "./drains"

const ENDPOINT = "https://app.example.com/api/drains/traces"

const traceDrain = {
  id: "drn_1",
  name: "agent-army observability",
  schemas: { trace: {} },
  delivery: { type: "http", endpoint: ENDPOINT, encoding: "json" },
}
const logDrain = {
  id: "drn_2",
  schemas: { log: {} },
  delivery: { type: "http", endpoint: ENDPOINT, encoding: "json" },
}

describe("findTraceDrain", () => {
  it("matches a trace drain pointing at our endpoint", () => {
    expect(findTraceDrain([logDrain, traceDrain], ENDPOINT)?.id).toBe("drn_1")
  })

  it("ignores trace drains for other endpoints and non-trace drains", () => {
    expect(findTraceDrain([logDrain], ENDPOINT)).toBeNull()
    expect(
      findTraceDrain(
        [{ ...traceDrain, delivery: { endpoint: "https://other/x" } }],
        ENDPOINT,
      ),
    ).toBeNull()
  })
})

// A fetch stub that routes by method: GET = list, POST = create.
function stubFetch(handlers: {
  list?: () => { status: number; body: unknown }
  create?: () => { status: number; body: unknown }
}): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const h = (init?.method ?? "GET") === "POST" ? handlers.create : handlers.list
    const { status, body } = h!()
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch
}

const cfg = {
  token: "tok",
  teamId: "team",
  secret: "whsec_x",
  endpoint: ENDPOINT,
}

describe("ensureTraceDrain", () => {
  it("returns unconfigured when secret/token/endpoint is missing", async () => {
    expect((await ensureTraceDrain({ ...cfg, secret: undefined })).status).toBe("unconfigured")
    expect((await ensureTraceDrain({ ...cfg, token: undefined })).status).toBe("unconfigured")
  })

  it("returns plan_blocked when the drains API is forbidden", async () => {
    const r = await ensureTraceDrain({
      ...cfg,
      fetchImpl: stubFetch({ list: () => ({ status: 403, body: { error: { code: "forbidden" } } }) }),
    })
    expect(r.status).toBe("plan_blocked")
  })

  it("returns active without creating when a matching drain already exists", async () => {
    const r = await ensureTraceDrain({
      ...cfg,
      fetchImpl: stubFetch({
        list: () => ({ status: 200, body: { drains: [traceDrain] } }),
        create: () => {
          throw new Error("should not create")
        },
      }),
    })
    expect(r).toEqual({ status: "active", id: "drn_1" })
  })

  it("creates the drain when none exists and returns active", async () => {
    const r = await ensureTraceDrain({
      ...cfg,
      fetchImpl: stubFetch({
        list: () => ({ status: 200, body: { drains: [] } }),
        create: () => ({ status: 200, body: { id: "drn_new" } }),
      }),
    })
    expect(r).toEqual({ status: "active", id: "drn_new" })
  })

  it("returns plan_blocked when creation is forbidden", async () => {
    const r = await ensureTraceDrain({
      ...cfg,
      fetchImpl: stubFetch({
        list: () => ({ status: 200, body: { drains: [] } }),
        create: () => ({ status: 403, body: { error: { code: "forbidden" } } }),
      }),
    })
    expect(r.status).toBe("plan_blocked")
  })
})
