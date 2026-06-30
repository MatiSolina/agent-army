import { describe, it, expect } from "vitest"
import { buildEveProject } from "./project"
import type { Agent, Connection } from "@/lib/db/schema"

// GOAL PROOF: an agent deployed from the fleet really carries its configured
// capabilities (skills, MCP tools/connections, subagents, schedules, sandbox)
// into the Eve project that gets shipped. This asserts the config -> deployable
// project mapping that deployAgent() uploads to Vercel.

function fullyConfiguredAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-fleet-1",
    userId: "demo-user",
    name: "Fleet Verify Bot",
    description: "Agent with every capability configured",
    model: "openai/gpt-4o-mini",
    systemPrompt: "You are a fleet verification agent.",
    temperature: 70,
    instructions: "You are a fleet verification agent.",
    maxSteps: 10,
    enabled: true,
    skills: [
      {
        id: "sk1",
        name: "Refund Policy",
        description: "How to handle refund requests",
        content: "## Steps\n1. Verify the order\n2. Issue the refund",
      },
    ],
    toolIds: [],
    connectionIds: ["conn-linear"],
    subagents: [
      {
        id: "sa1",
        name: "Researcher",
        model: "openai/gpt-4o-mini",
        instructions: "Research thoroughly and report findings.",
      },
    ],
    schedules: [
      {
        id: "scd1",
        name: "Daily digest",
        cron: "0 9 * * *",
        prompt: "Summarize yesterday's tickets.",
        enabled: true,
      },
    ],
    sandbox: { enabled: true, runtime: "node24" },
    deploymentStatus: "none",
    deploymentUrl: null,
    vercelProjectId: null,
    lastDeployedAt: null,
    deploymentError: null,
    previewUrl: null,
    previewDeploymentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Agent
}

const linear: Connection = {
  id: "conn-linear",
  userId: "demo-user",
  name: "Linear",
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  token: null,
  status: "connected",
  oauthClientInfo: null as never,
  oauthServerInfo: null as never,
  oauthTokens: null as never,
  oauthTokensUpdatedAt: null,
  oauthCodeVerifier: null,
  oauthState: null,
  oauthScope: null,
  oauthError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as Connection

describe("a fleet-deployed agent carries its configured capabilities", () => {
  const files = buildEveProject(fullyConfiguredAgent(), { connections: [linear] })
  const paths = Object.keys(files)

  it("is a valid deployable Eve project (package.json pins eve)", () => {
    expect(paths).toContain("package.json")
    expect(JSON.parse(files["package.json"]).dependencies.eve).toBeTruthy()
    expect(paths).toContain("agent/agent.ts")
    expect(files["agent/agent.ts"]).toContain("openai/gpt-4o-mini")
  })

  it("ships the configured SKILL with its content", () => {
    const skill = paths.find((p) => p.startsWith("agent/skills/"))
    expect(skill).toBeTruthy()
    expect(skill).toMatch(/refund/i) // filename derives from the skill name
    expect(files[skill!]).toContain("How to handle refund requests") // description
    expect(files[skill!]).toContain("Issue the refund") // content body
  })

  it("ships the configured MCP CONNECTION (the agent's tools source)", () => {
    const conn = paths.find((p) => p.startsWith("agent/connections/"))
    expect(conn).toBeTruthy()
    expect(files[conn!]).toContain("https://mcp.linear.app/mcp")
    expect(files[conn!]).toContain("defineMcpClientConnection")
  })

  it("authenticates the OAuth connection via the FM token broker (no Vercel Connect)", () => {
    // OAuth connections now resolve their token from the Fleet Manager token
    // broker (a plain fetch with the EVE_API_SECRET bearer), so the generated
    // file must NOT reference Vercel Connect and the project must NOT declare it.
    const conn = paths.find((p) => p.startsWith("agent/connections/"))
    expect(files[conn!]).toContain("getToken")
    expect(files[conn!]).toContain("process.env.FM_BASE_URL")
    expect(files[conn!]).not.toContain("@vercel/connect")
    const deps = JSON.parse(files["package.json"]).dependencies
    expect(deps["@vercel/connect"]).toBeUndefined()
  })

  it("ships the configured SUBAGENT", () => {
    const sub = paths.find((p) => p.startsWith("agent/subagents/") && p.endsWith("agent.ts"))
    expect(sub).toBeTruthy()
    expect(files[sub!]).toContain("defineAgent")
  })

  it("ships the configured SCHEDULE (cron)", () => {
    const sched = paths.find((p) => p.startsWith("agent/schedules/"))
    expect(sched).toBeTruthy()
    expect(files[sched!]).toContain("0 9 * * *")
  })

  it("ships the configured SANDBOX", () => {
    expect(paths.some((p) => p.startsWith("agent/sandbox"))).toBe(true)
  })
})
