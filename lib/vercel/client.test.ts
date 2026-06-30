import { describe, it, expect, vi } from "vitest"
import {
  createDeployment,
  getDeployment,
  getBuildErrorText,
  getBuildEvents,
  pollUntilReady,
  getReadyState,
  ensureProject,
  deleteProject,
  deleteDeployment,
  upsertProjectEnv,
  listProjectEnvKeys,
  promoteDeployment,
  listDeployments,
  getProductionDeploymentId,
  attachConnectorToProject,
  attachTriggerDestination,
  listConnectors,
  listProjects,
  getDeploymentFileTree,
  getDeploymentFile,
} from "./client"
import type { VercelClientConfig } from "./client"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = "test-token-secret"
const TEAM_ID = "team_abc"

function makeCfg(overrides?: Partial<VercelClientConfig>): VercelClientConfig {
  return { token: TOKEN, teamId: TEAM_ID, ...overrides }
}

function makeFetch(
  responses: Array<{ ok: boolean; status: number; body: unknown }>
) {
  let call = 0
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const resp = responses[call++] ?? responses[responses.length - 1]
    const json = async () => resp.body
    const text = async () => JSON.stringify(resp.body)
    return { ok: resp.ok, status: resp.status, json, text } as unknown as Response
  })
}

const FILES = [{ file: "package.json", data: "{}", encoding: "utf-8" as const }]

// ---------------------------------------------------------------------------
// attachConnectorToProject
// ---------------------------------------------------------------------------
describe("attachConnectorToProject", () => {
  it("resolves the connector UID + project name, then POSTs the attach for all envs", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "scl_123", uid: "slack/agentarmy" } }, // resolve connector
      { ok: true, status: 200, body: { id: "prj_456", name: "my-agent" } }, // resolve project
      { ok: true, status: 200, body: {} }, // attach
    ])
    await attachConnectorToProject(makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }), "slack/agentarmy", "my-agent")

    const calls = fetch.mock.calls
    // UID is URL-encoded in the resolve call.
    expect(calls[0][0]).toContain("/v1/connect/connectors/slack%2Fagentarmy")
    expect(calls[1][0]).toContain("/v9/projects/my-agent")
    // Attach uses the resolved ids, POST, with the environments body.
    expect(calls[2][0]).toContain(
      "/v1/connect/connectors/scl_123/projects/prj_456",
    )
    expect(calls[2][1]!.method).toBe("POST")
    expect(JSON.parse(calls[2][1]!.body as string).environments).toEqual(
      expect.arrayContaining(["production", "preview", "development"]),
    )
  })

  it("throws when the attach POST fails", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "scl_123" } },
      { ok: true, status: 200, body: { id: "prj_456" } },
      { ok: false, status: 403, body: { error: "forbidden" } },
    ])
    await expect(
      attachConnectorToProject(makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }), "slack/agentarmy", "my-agent"),
    ).rejects.toThrow(/403/)
  })
})

// ---------------------------------------------------------------------------
// listConnectors
// ---------------------------------------------------------------------------
describe("listConnectors", () => {
  it("GETs /v1/connect/connectors and maps the clients array", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: {
          clients: [
            { uid: "slack/agentbot", type: "slack", supportsTriggers: true },
            { uid: "linear/x", type: "linear", supportsTriggers: false },
          ],
        },
      },
    ])
    const out = await listConnectors(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
    )
    expect(fetch.mock.calls[0][0]).toContain("/v1/connect/connectors")
    expect(out).toEqual([
      { uid: "slack/agentbot", type: "slack", supportsTriggers: true },
      { uid: "linear/x", type: "linear", supportsTriggers: false },
    ])
  })

  it("returns [] when the request fails (best-effort)", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: {} }])
    const out = await listConnectors(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
    )
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// attachTriggerDestination
// ---------------------------------------------------------------------------
describe("attachTriggerDestination", () => {
  it("resolves connector + project, then PATCHes the trigger destination path", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "scl_123", uid: "slack/soporte" } }, // resolve connector
      { ok: true, status: 200, body: { id: "prj_456", name: "soporte-a1" } }, // resolve project
      { ok: true, status: 200, body: {} }, // PATCH trigger-destinations
    ])
    await attachTriggerDestination(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "slack/soporte",
      "soporte-a1",
      "/eve/v1/slack",
    )

    const calls = fetch.mock.calls
    expect(calls[0][0]).toContain("/v1/connect/connectors/slack%2Fsoporte")
    expect(calls[1][0]).toContain("/v9/projects/soporte-a1")
    expect(calls[2][0]).toContain(
      "/v1/connect/connectors/scl_123/trigger-destinations",
    )
    expect(calls[2][1]!.method).toBe("PATCH")
    const body = JSON.parse(calls[2][1]!.body as string)
    expect(body.destinations).toEqual([
      { projectId: "prj_456", path: "/eve/v1/slack" },
    ])
  })

  it("throws when the PATCH fails", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "scl_123" } },
      { ok: true, status: 200, body: { id: "prj_456" } },
      { ok: false, status: 403, body: { error: "forbidden" } },
    ])
    await expect(
      attachTriggerDestination(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "slack/soporte",
        "soporte-a1",
        "/eve/v1/slack",
      ),
    ).rejects.toThrow(/403/)
  })
})

// ---------------------------------------------------------------------------
// createDeployment
// ---------------------------------------------------------------------------
describe("createDeployment", () => {
  it("POSTs to correct URL with teamId and skipAutoDetectionConfirmation", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { id: "dpl_1", url: "proj.vercel.app", readyState: "QUEUED" },
      },
    ])
    await createDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      { name: "my-agent", files: FILES }
    )
    const [url] = fetch.mock.calls[0]
    expect(url).toContain("teamId=team_abc")
    expect(url).toContain("skipAutoDetectionConfirmation=1")
    expect(url).toContain("/v13/deployments")
  })

  it("includes Authorization Bearer header", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { id: "dpl_1", url: "proj.vercel.app", readyState: "QUEUED" },
      },
    ])
    await createDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      { name: "my-agent", files: FILES }
    )
    const [, init] = fetch.mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`)
  })

  it("sends projectSettings.framework === 'eve' in request body", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { id: "dpl_1", url: "proj.vercel.app", readyState: "QUEUED" },
      },
    ])
    await createDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      { name: "my-agent", files: FILES }
    )
    const [, init] = fetch.mock.calls[0]
    const body = JSON.parse(init?.body as string)
    expect(body.projectSettings?.framework).toBe("eve")
  })

  it("sends a staged production deploy (target:production + skip-domain)", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { id: "dpl_1", url: "proj.vercel.app", readyState: "QUEUED" },
      },
    ])
    await createDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      { name: "my-agent", files: FILES }
    )
    const [, init] = fetch.mock.calls[0]
    const body = JSON.parse(init?.body as string)
    expect(body.name).toBe("my-agent")
    expect(body.project).toBe("my-agent")
    // Must be a production-target build (else /promote rejects it 422), but with
    // the production domain NOT auto-assigned so it stays testable until promote.
    expect(body.target).toBe("production")
    expect(body.autoAssignCustomDomains).toBe(false)
    expect(body.files).toEqual(FILES)
  })

  it("parses and returns the deployment response", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { id: "dpl_99", url: "proj-99.vercel.app", readyState: "QUEUED" },
      },
    ])
    const result = await createDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      { name: "my-agent", files: FILES }
    )
    expect(result.id).toBe("dpl_99")
    expect(result.url).toBe("https://proj-99.vercel.app")
    expect(result.readyState).toBe("QUEUED")
  })

  it("throws with status in message on non-2xx", async () => {
    const fetch = makeFetch([
      { ok: false, status: 403, body: { error: { message: "Forbidden" } } },
    ])
    await expect(
      createDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        { name: "my-agent", files: FILES }
      )
    ).rejects.toThrow("403")
  })

  it("never sends an inline env in the body (secrets live on the project)", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { id: "dpl_1", url: "proj.vercel.app", readyState: "QUEUED" },
      },
    ])
    await createDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      { name: "my-agent", files: FILES }
    )
    const [, init] = fetch.mock.calls[0]
    const body = JSON.parse(init?.body as string)
    expect(body).not.toHaveProperty("env")
  })

  it("omits teamId query param when teamId is not set", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { id: "dpl_1", url: "proj.vercel.app", readyState: "QUEUED" },
      },
    ])
    await createDeployment(
      { token: TOKEN, fetchImpl: fetch as unknown as typeof globalThis.fetch },
      { name: "my-agent", files: FILES }
    )
    const [url] = fetch.mock.calls[0]
    expect(url).not.toContain("teamId=")
  })
})

// ---------------------------------------------------------------------------
// getDeployment
// ---------------------------------------------------------------------------
describe("getDeployment", () => {
  it("GETs the correct URL with id and teamId", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: {
          id: "dpl_abc",
          url: "proj-abc.vercel.app",
          readyState: "READY",
        },
      },
    ])
    await getDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc"
    )
    const [url] = fetch.mock.calls[0]
    expect(url).toContain("/v13/deployments/dpl_abc")
    expect(url).toContain("teamId=team_abc")
  })

  it("parses the response", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: {
          id: "dpl_abc",
          url: "proj-abc.vercel.app",
          readyState: "READY",
        },
      },
    ])
    const result = await getDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc"
    )
    expect(result.readyState).toBe("READY")
    expect(result.url).toBe("https://proj-abc.vercel.app")
  })

  it("throws on non-2xx", async () => {
    const fetch = makeFetch([{ ok: false, status: 404, body: "Not found" }])
    await expect(
      getDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "dpl_abc"
      )
    ).rejects.toThrow("404")
  })
})

// ---------------------------------------------------------------------------
// getBuildErrorText
// ---------------------------------------------------------------------------
describe("getBuildErrorText", () => {
  it("GETs the events URL with builds=1 and limit=-1", async () => {
    const fetch = makeFetch([{ ok: true, status: 200, body: [] }])
    await getBuildErrorText(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc"
    )
    const [url] = fetch.mock.calls[0]
    expect(url).toContain("/v3/deployments/dpl_abc/events")
    expect(url).toContain("builds=1")
    expect(url).toContain("limit=-1")
  })

  it("returns extracted error text on success", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: [{ type: "stderr", text: "Build crashed" }],
      },
    ])
    const result = await getBuildErrorText(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc"
    )
    expect(result).toContain("Build crashed")
  })

  it("returns fallback string (does not throw) on non-2xx", async () => {
    const fetch = makeFetch([{ ok: false, status: 500, body: "oops" }])
    const result = await getBuildErrorText(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc"
    )
    expect(result).toBe("(could not fetch build logs)")
  })
})

// ---------------------------------------------------------------------------
// getBuildEvents: live build log tail
// ---------------------------------------------------------------------------
describe("getBuildEvents", () => {
  it("GETs the events URL with builds=1 and limit=-1", async () => {
    const fetch = makeFetch([{ ok: true, status: 200, body: [] }])
    await getBuildEvents(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc",
    )
    const [url] = fetch.mock.calls[0]
    expect(url).toContain("/v3/deployments/dpl_abc/events")
    expect(url).toContain("builds=1")
    expect(url).toContain("limit=-1")
  })

  it("returns ordered log lines on success", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: [
          { type: "command", text: "Running build" },
          { type: "stdout", text: "compiling…" },
        ],
      },
    ])
    const result = await getBuildEvents(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc",
    )
    expect(result).toEqual(["Running build", "compiling…"])
  })

  it("returns [] (does not throw) on non-2xx", async () => {
    const fetch = makeFetch([{ ok: false, status: 500, body: "oops" }])
    const result = await getBuildEvents(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc",
    )
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// pollUntilReady
// ---------------------------------------------------------------------------

// getReadyState: single-shot, no loop. The workflow drives this itself with
// durable sleeps; pollUntilReady keeps its blocking loop by calling it.
describe("getReadyState", () => {
  it("maps a READY deployment to READY", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "dpl_1", url: "u", readyState: "READY" } },
    ])
    const state = await getReadyState(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_1",
    )
    expect(state).toBe("READY")
  })

  it("maps ERROR and CANCELED to ERROR", async () => {
    for (const readyState of ["ERROR", "CANCELED"] as const) {
      const fetch = makeFetch([
        { ok: true, status: 200, body: { id: "dpl_1", url: "u", readyState } },
      ])
      const state = await getReadyState(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "dpl_1",
      )
      expect(state).toBe("ERROR")
    }
  })

  it("collapses transient states (QUEUED/BUILDING/INITIALIZING) to BUILDING", async () => {
    for (const readyState of ["QUEUED", "BUILDING", "INITIALIZING"] as const) {
      const fetch = makeFetch([
        { ok: true, status: 200, body: { id: "dpl_1", url: "u", readyState } },
      ])
      const state = await getReadyState(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "dpl_1",
      )
      expect(state).toBe("BUILDING")
    }
  })
})

describe("pollUntilReady", () => {
  it("resolves with READY url after BUILDING then READY", async () => {
    let call = 0
    const fakeFetch = vi.fn(async (url: string) => {
      if (String(url).includes("/events")) {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response
      }
      call++
      const body =
        call === 1
          ? { id: "dpl_1", url: "proj.vercel.app", readyState: "BUILDING" }
          : { id: "dpl_1", url: "proj.vercel.app", readyState: "READY" }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    })
    const sleep = vi.fn(async (_ms: number) => undefined)
    const result = await pollUntilReady(
      makeCfg({ fetchImpl: fakeFetch as unknown as typeof globalThis.fetch }),
      "dpl_1",
      { intervalMs: 100, timeoutMs: 60000, sleep }
    )
    expect(result.readyState).toBe("READY")
    expect(result.url).toBe("https://proj.vercel.app")
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it("throws with error text when state is ERROR", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (String(url).includes("/events")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ type: "stderr", text: "compile error" }],
        } as unknown as Response
      }
      const body = { id: "dpl_2", url: "proj.vercel.app", readyState: "ERROR" }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    })
    const sleep = vi.fn(async (_ms: number) => undefined)
    await expect(
      pollUntilReady(
        makeCfg({ fetchImpl: fakeFetch as unknown as typeof globalThis.fetch }),
        "dpl_2",
        { intervalMs: 100, timeoutMs: 60000, sleep }
      )
    ).rejects.toThrow("compile error")
  })

  it("throws timeout error when pending past timeoutMs", async () => {
    let now = 0
    const fakeFetch = vi.fn(async (_url: string) => {
      const body = { id: "dpl_3", url: "proj.vercel.app", readyState: "BUILDING" }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    })
    const sleep = vi.fn(async (ms: number) => {
      now += ms
    })
    await expect(
      pollUntilReady(
        makeCfg({ fetchImpl: fakeFetch as unknown as typeof globalThis.fetch }),
        "dpl_3",
        {
          intervalMs: 1000,
          timeoutMs: 3000,
          sleep,
          now: () => now,
        }
      )
    ).rejects.toThrow("timed out")
  })

})

// ---------------------------------------------------------------------------
// ensureProject
// ---------------------------------------------------------------------------
describe("ensureProject", () => {
  it("returns existed:true and does NOT POST when GET finds the project", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "prj_1", name: "my-agent" } },
    ])
    const result = await ensureProject(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toEqual({ existed: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toContain("/v9/projects/my-agent")
    expect(url).toContain("teamId=team_abc")
    expect((init as RequestInit | undefined)?.method).toBe("GET")
  })

  it("creates the project (POST /v11/projects {name}) on 404, returns existed:false", async () => {
    const fetch = makeFetch([
      { ok: false, status: 404, body: { error: { code: "not_found" } } },
      { ok: true, status: 200, body: { id: "prj_2", name: "my-agent" } },
    ])
    const result = await ensureProject(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toEqual({ existed: false })
    expect(fetch).toHaveBeenCalledTimes(2)
    const [postUrl, postInit] = fetch.mock.calls[1]
    expect(postUrl).toContain("/v11/projects")
    expect(postUrl).toContain("teamId=team_abc")
    expect((postInit as RequestInit).method).toBe("POST")
    const body = JSON.parse((postInit as RequestInit).body as string)
    expect(body.name).toBe("my-agent")
    // We must NOT send a framework on project create (per-deployment supplies it).
    expect(body).not.toHaveProperty("framework")
  })

  it("treats a name-collision error on POST as existed:true (race-safe)", async () => {
    const fetch = makeFetch([
      { ok: false, status: 404, body: { error: { code: "not_found" } } },
      {
        ok: false,
        status: 409,
        body: { error: { code: "project_name_already_exists" } },
      },
    ])
    const result = await ensureProject(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toEqual({ existed: true })
  })

  it("throws on a non-404 GET failure", async () => {
    const fetch = makeFetch([{ ok: false, status: 401, body: "Unauthorized" }])
    await expect(
      ensureProject(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      ),
    ).rejects.toThrow("401")
  })

  it("throws on a non-collision POST failure", async () => {
    const fetch = makeFetch([
      { ok: false, status: 404, body: { error: { code: "not_found" } } },
      { ok: false, status: 500, body: { error: { message: "boom" } } },
    ])
    await expect(
      ensureProject(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      ),
    ).rejects.toThrow("500")
  })

  it("does not leak the token in error messages", async () => {
    const fetch = makeFetch([{ ok: false, status: 401, body: "Unauthorized" }])
    let caught: Error | null = null
    try {
      await ensureProject(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// deleteProject
// ---------------------------------------------------------------------------
describe("deleteProject", () => {
  it("DELETEs /v9/projects/{name} and returns existed:true on success", async () => {
    const fetch = makeFetch([{ ok: true, status: 200, body: {} }])
    const result = await deleteProject(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toEqual({ existed: true })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toContain("/v9/projects/my-agent")
    expect(url).toContain("teamId=team_abc")
    expect((init as RequestInit).method).toBe("DELETE")
  })

  it("treats a 404 (already gone) as existed:false, no throw", async () => {
    const fetch = makeFetch([{ ok: false, status: 404, body: "Not found" }])
    const result = await deleteProject(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toEqual({ existed: false })
  })

  it("throws on a non-404 failure", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: "Forbidden" }])
    await expect(
      deleteProject(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      ),
    ).rejects.toThrow("403")
  })

  it("does not leak the token in error messages", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: "Forbidden" }])
    let caught: Error | null = null
    try {
      await deleteProject(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// deleteDeployment
// ---------------------------------------------------------------------------
describe("deleteDeployment", () => {
  it("DELETEs /v13/deployments/{id} and returns existed:true on success", async () => {
    const fetch = makeFetch([{ ok: true, status: 200, body: {} }])
    const result = await deleteDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_PREVIEW",
    )
    expect(result).toEqual({ existed: true })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toContain("/v13/deployments/dpl_PREVIEW")
    expect(url).toContain("teamId=team_abc")
    expect((init as RequestInit).method).toBe("DELETE")
  })

  it("treats a 404 (already gone) as existed:false, no throw", async () => {
    const fetch = makeFetch([{ ok: false, status: 404, body: "Not found" }])
    const result = await deleteDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_GONE",
    )
    expect(result).toEqual({ existed: false })
  })

  it("escapes the deployment id in the path", async () => {
    const fetch = makeFetch([{ ok: true, status: 200, body: {} }])
    await deleteDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl/../x",
    )
    const [url] = fetch.mock.calls[0]
    expect(url).toContain("/v13/deployments/dpl%2F..%2Fx")
  })

  it("throws on a non-404 failure", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: "Forbidden" }])
    await expect(
      deleteDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "dpl_x",
      ),
    ).rejects.toThrow("403")
  })

  it("does not leak the token in error messages", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: "Forbidden" }])
    let caught: Error | null = null
    try {
      await deleteDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "dpl_x",
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// upsertProjectEnv
// ---------------------------------------------------------------------------
describe("upsertProjectEnv", () => {
  it("POSTs to the env endpoint with upsert=true and an array body", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { created: [{ key: "A" }], failed: [] } },
    ])
    await upsertProjectEnv(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
      [{ key: "ACME_TOKEN", value: "secret" }],
    )
    const [url, init] = fetch.mock.calls[0]
    expect(url).toContain("/v10/projects/my-agent/env")
    expect(url).toContain("upsert=true")
    expect(url).toContain("teamId=team_abc")
    expect((init as RequestInit).method).toBe("POST")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toEqual({
      key: "ACME_TOKEN",
      value: "secret",
      type: "encrypted",
      target: ["production", "preview"],
    })
  })

  it("is a no-op (no fetch) when specs is empty", async () => {
    const fetch = makeFetch([{ ok: true, status: 200, body: {} }])
    await upsertProjectEnv(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
      [],
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it("throws on a non-2xx response", async () => {
    const fetch = makeFetch([
      { ok: false, status: 403, body: { error: { message: "Forbidden" } } },
    ])
    await expect(
      upsertProjectEnv(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
        [{ key: "K", value: "v" }],
      ),
    ).rejects.toThrow("403")
  })

  it("throws (keys only) when the response reports failed entries", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { created: [], failed: [{ error: { key: "BAD_KEY" } }] },
      },
    ])
    let caught: Error | null = null
    try {
      await upsertProjectEnv(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
        [{ key: "BAD_KEY", value: "supersecretvalue" }],
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain("BAD_KEY")
    expect(caught!.message).not.toContain("supersecretvalue")
  })

  it("NEVER includes a secret value in a thrown error message", async () => {
    const fetch = makeFetch([{ ok: false, status: 500, body: "server error" }])
    let caught: Error | null = null
    try {
      await upsertProjectEnv(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
        [{ key: "K", value: "supersecretvalue" }],
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain("supersecretvalue")
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// listProjectEnvKeys
// ---------------------------------------------------------------------------
describe("listProjectEnvKeys", () => {
  it("GETs the env endpoint WITHOUT decrypt and returns keys only", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: {
          envs: [
            {
              key: "ACME_TOKEN",
              type: "encrypted",
              target: ["production", "preview"],
              value: "leak?",
            },
          ],
        },
      },
    ])
    const result = await listProjectEnvKeys(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    const [url] = fetch.mock.calls[0]
    expect(url).toContain("/v10/projects/my-agent/env")
    expect(url).not.toContain("decrypt")
    expect(result).toEqual([
      { key: "ACME_TOKEN", target: ["production", "preview"], type: "encrypted" },
    ])
    expect(JSON.stringify(result)).not.toContain("leak")
  })

  it("returns [] on 404 (project not yet created)", async () => {
    const fetch = makeFetch([{ ok: false, status: 404, body: "Not found" }])
    const result = await listProjectEnvKeys(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toEqual([])
  })

  it("throws on a non-404 failure", async () => {
    const fetch = makeFetch([{ ok: false, status: 500, body: "boom" }])
    await expect(
      listProjectEnvKeys(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      ),
    ).rejects.toThrow("500")
  })
})

// ---------------------------------------------------------------------------
// promoteDeployment
// ---------------------------------------------------------------------------
describe("promoteDeployment", () => {
  it("resolves the project NAME to its id, then POSTs promote by id", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "prj_99", name: "my-agent" } },
      { ok: true, status: 200, body: {} },
    ])
    await promoteDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
      "dpl_42",
    )
    // 1st call resolves name -> id.
    const [resolveUrl, resolveInit] = fetch.mock.calls[0]
    expect(resolveUrl).toContain("/v9/projects/my-agent")
    expect((resolveInit as RequestInit).method).toBe("GET")
    // 2nd call promotes by the resolved prj_ id (NOT the name, which 404s).
    const [url, init] = fetch.mock.calls[1]
    expect(url).toContain("/v10/projects/prj_99/promote/dpl_42")
    expect(url).not.toContain("my-agent")
    expect(url).toContain("teamId=team_abc")
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).body).toBe("{}")
  })

  it("encodeURIComponent-escapes the path segments", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "prj_x" } },
      { ok: true, status: 200, body: {} },
    ])
    await promoteDeployment(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "weird/name",
      "dpl id",
    )
    // The name is escaped in the resolve GET; the deployment id in the promote POST.
    expect(fetch.mock.calls[0][0]).toContain("/v9/projects/weird%2Fname")
    expect(fetch.mock.calls[1][0]).toContain("/promote/dpl%20id")
  })

  it("omits teamId when not set", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { id: "prj_x" } },
      { ok: true, status: 200, body: {} },
    ])
    await promoteDeployment(
      { token: TOKEN, fetchImpl: fetch as unknown as typeof globalThis.fetch },
      "my-agent",
      "dpl_42",
    )
    expect(fetch.mock.calls[1][0]).not.toContain("teamId=")
  })

  it("throws with status on non-2xx", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: "Forbidden" }])
    await expect(
      promoteDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
        "dpl_42",
      ),
    ).rejects.toThrow("403")
  })

  it("does not leak the token in error messages", async () => {
    const fetch = makeFetch([{ ok: false, status: 401, body: "Unauthorized" }])
    let caught: Error | null = null
    try {
      await promoteDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
        "dpl_42",
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// listDeployments
// ---------------------------------------------------------------------------
describe("listDeployments", () => {
  it("GETs the deployments endpoint with projectId, limit, and teamId", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: {
          deployments: [
            {
              uid: "dpl_1",
              url: "p1.vercel.app",
              created: 10,
              state: "READY",
              target: "production",
            },
          ],
        },
      },
    ])
    const result = await listDeployments(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    const [url, init] = fetch.mock.calls[0]
    expect(url).toContain("/v6/deployments")
    expect(url).toContain("projectId=my-agent")
    expect(url).toContain("limit=20")
    expect(url).toContain("teamId=team_abc")
    expect((init as RequestInit).method).toBe("GET")
    expect(result).toEqual([
      {
        id: "dpl_1",
        url: "p1.vercel.app",
        state: "READY",
        createdAt: 10,
        target: "production",
      },
    ])
  })

  it("honors a custom limit", async () => {
    const fetch = makeFetch([{ ok: true, status: 200, body: { deployments: [] } }])
    await listDeployments(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
      5,
    )
    const [url] = fetch.mock.calls[0]
    expect(url).toContain("limit=5")
  })

  it("returns [] on 404", async () => {
    const fetch = makeFetch([{ ok: false, status: 404, body: "Not found" }])
    const result = await listDeployments(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toEqual([])
  })

  it("throws on a non-404 failure", async () => {
    const fetch = makeFetch([{ ok: false, status: 500, body: "boom" }])
    await expect(
      listDeployments(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      ),
    ).rejects.toThrow("500")
  })

  it("does not leak the token in error messages", async () => {
    const fetch = makeFetch([{ ok: false, status: 401, body: "Unauthorized" }])
    let caught: Error | null = null
    try {
      await listDeployments(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// getProductionDeploymentId
// ---------------------------------------------------------------------------
describe("getProductionDeploymentId", () => {
  it("GETs the project endpoint and returns the production deployment id", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: { targets: { production: { id: "dpl_prod", url: "p.vercel.app" } } },
      },
    ])
    const result = await getProductionDeploymentId(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    const [url, init] = fetch.mock.calls[0]
    expect(url).toContain("/v9/projects/my-agent")
    expect(url).toContain("teamId=team_abc")
    expect((init as RequestInit).method).toBe("GET")
    expect(result).toBe("dpl_prod")
  })

  it("returns null when there is no production target", async () => {
    const fetch = makeFetch([
      { ok: true, status: 200, body: { targets: {} } },
    ])
    const result = await getProductionDeploymentId(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toBeNull()
  })

  it("returns null on 404 (project not yet created)", async () => {
    const fetch = makeFetch([{ ok: false, status: 404, body: "Not found" }])
    const result = await getProductionDeploymentId(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "my-agent",
    )
    expect(result).toBeNull()
  })

  it("throws on a non-404 failure", async () => {
    const fetch = makeFetch([{ ok: false, status: 500, body: "boom" }])
    await expect(
      getProductionDeploymentId(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      ),
    ).rejects.toThrow("500")
  })

  it("does not leak the token in error messages", async () => {
    const fetch = makeFetch([{ ok: false, status: 401, body: "Unauthorized" }])
    let caught: Error | null = null
    try {
      await getProductionDeploymentId(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "my-agent",
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// Security: the Bearer token must never appear in a thrown Error message
// (those messages can reach logs / the DB error column).
// ---------------------------------------------------------------------------
describe("security: token never leaks into error messages", () => {
  it("createDeployment failure does not include the token", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: "Forbidden" }])
    let caught: Error | null = null
    try {
      await createDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        { name: "my-agent", files: FILES }
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })

  it("getDeployment failure does not include the token", async () => {
    const fetch = makeFetch([{ ok: false, status: 401, body: "Unauthorized" }])
    let caught: Error | null = null
    try {
      await getDeployment(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "dpl_x"
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).not.toContain(TOKEN)
  })

  it("pollUntilReady build-failure error does not include the token", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      const body = url.includes("/events")
        ? [{ type: "stderr", text: "build blew up" }]
        : { id: "dpl_y", url: "y.vercel.app", readyState: "ERROR" }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    })
    let caught: Error | null = null
    try {
      await pollUntilReady(
        makeCfg({ fetchImpl: fakeFetch as unknown as typeof globalThis.fetch }),
        "dpl_y",
        { sleep: async () => {}, now: () => 0 }
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain("build blew up")
    expect(caught!.message).not.toContain(TOKEN)
  })
})

// ---------------------------------------------------------------------------
// listProjects / getDeploymentFileTree / getDeploymentFile (import readers)
// ---------------------------------------------------------------------------
describe("listProjects", () => {
  it("GETs /v10/projects with teamId + search and parses the list", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: {
          projects: [
            { id: "prj_1", name: "content-agent-x", framework: "eve", targets: { production: { id: "dpl_9" } } },
          ],
          pagination: { count: 1, next: null },
        },
      },
    ])
    const out = await listProjects(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      { search: "agent", limit: 50 },
    )
    const url = fetch.mock.calls[0][0] as string
    expect(url).toContain("/v10/projects")
    expect(url).toContain(`teamId=${TEAM_ID}`)
    expect(url).toContain("search=agent")
    expect(out.projects[0]).toEqual({
      id: "prj_1",
      name: "content-agent-x",
      framework: "eve",
      productionDeploymentId: "dpl_9",
    })
  })

  it("never leaks the token in a thrown error", async () => {
    const fetch = makeFetch([{ ok: false, status: 403, body: { error: "forbidden" } }])
    await expect(
      listProjects(makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch })),
    ).rejects.toThrow(/403/)
    await expect(
      listProjects(makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch })),
    ).rejects.not.toThrow(new RegExp(TOKEN))
  })
})

describe("getDeploymentFileTree", () => {
  it("GETs /v6/deployments/{id}/files and flattens to file leaves", async () => {
    const fetch = makeFetch([
      {
        ok: true,
        status: 200,
        body: [
          {
            name: "src",
            type: "directory",
            children: [{ name: "package.json", type: "file", uid: "u1" }],
          },
        ],
      },
    ])
    const out = await getDeploymentFileTree(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc",
    )
    expect((fetch.mock.calls[0][0] as string)).toContain("/v6/deployments/dpl_abc/files")
    expect(out).toEqual([{ path: "src/package.json", uid: "u1" }])
  })

  it("returns [] on 404", async () => {
    const fetch = makeFetch([{ ok: false, status: 404, body: {} }])
    const out = await getDeploymentFileTree(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_missing",
    )
    expect(out).toEqual([])
  })
})

describe("getDeploymentFile", () => {
  it("GETs /v8/deployments/{id}/files/{uid} and decodes the {data:base64} body", async () => {
    const source = 'export default defineAgent({ model: "x" })\n'
    const b64 = Buffer.from(source, "utf-8").toString("base64")
    const fetch = makeFetch([{ ok: true, status: 200, body: { data: b64 } }])
    const out = await getDeploymentFile(
      makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
      "dpl_abc",
      "u1",
    )
    expect((fetch.mock.calls[0][0] as string)).toContain("/v8/deployments/dpl_abc/files/u1")
    expect(out).toBe(source)
  })

  it("never leaks the token in a thrown error", async () => {
    const fetch = makeFetch([{ ok: false, status: 410, body: { error: "Invalid API version" } }])
    let caught: Error | null = null
    try {
      await getDeploymentFile(
        makeCfg({ fetchImpl: fetch as unknown as typeof globalThis.fetch }),
        "dpl_abc",
        "u1",
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain("410")
    expect(caught!.message).not.toContain(TOKEN)
  })
})
