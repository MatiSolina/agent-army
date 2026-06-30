import { describe, it, expect } from "vitest"
import {
  buildEveProject,
  projectName,
  EVE_VERSION,
  EVE_AI_VERSION,
  EVE_ZOD_VERSION,
  EVE_OTEL_VERSION,
  EVE_CONNECT_VERSION,
} from "./project"
import { buildEveAgent } from "./generate"
import type { Agent, Tool, Connection } from "@/lib/db/schema"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-12345678-abcd",
    userId: "user-1",
    name: "Support Bot",
    description: "Helps customers",
    model: "openai/gpt-4o-mini",
    systemPrompt: "You are a helpful support agent.",
    temperature: 70,
    instructions: "Be concise.",
    maxSteps: 10,
    enabled: true,
    skills: [],
    toolIds: [],
    connectionIds: [],
    subagents: [],
    schedules: [],
    sandbox: { enabled: false },
    harness: {},
    vercelProjectId: null,
    deploymentUrl: null,
    deploymentStatus: "none",
    eveVersion: null,
    lastDeployedAt: null,
    deployedConfigHash: null,
    deployedConfig: null,
    deploymentError: null,
    previewUrl: null,
    previewDeploymentId: null,
    eveVerifiedVersion: null,
    eveVerifyError: null,
    imported: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const empty: { tools: Tool[]; connections: Connection[] } = {
  tools: [],
  connections: [],
}

// ---------------------------------------------------------------------------
// projectName
// ---------------------------------------------------------------------------

describe("projectName", () => {
  it("lowercases and collapses non-alphanumerics into single dashes", () => {
    expect(projectName(makeAgent({ name: "My Agent!!" }))).toBe(
      "my-agent-12345678",
    )
    expect(projectName(makeAgent({ name: "Foo   Bar___Baz" }))).toBe(
      "foo-bar-baz-12345678",
    )
  })

  it("strips leading and trailing dashes", () => {
    expect(projectName(makeAgent({ name: "  ...Hello World!!! " }))).toBe(
      "hello-world-12345678",
    )
    expect(projectName(makeAgent({ name: "---edge---" }))).toBe(
      "edge-12345678",
    )
  })

  it("falls back to agent-<id8> when the name has no usable chars", () => {
    expect(projectName(makeAgent({ name: "   ", id: "abcd1234-zzzz" }))).toBe(
      "agent-abcd1234",
    )
    expect(projectName(makeAgent({ name: "!!!", id: "deadbeef-9999" }))).toBe(
      "agent-deadbeef",
    )
  })

  it("neutralizes malicious / shell-metachar input", () => {
    expect(
      projectName(makeAgent({ name: "a/b; rm -rf / && echo $(whoami)" })),
    ).toBe("a-b-rm-rf-echo-whoami-12345678")
    // result must match the canonical safe pattern
    const slug = projectName(makeAgent({ name: "a/b; rm -rf /" }))
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,99}$/)
  })

  it("caps length at 100 chars", () => {
    const slug = projectName(makeAgent({ name: "x".repeat(250) }))
    expect(slug.length).toBe(100)
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })

  it("keeps same-name agents in separate Vercel projects", () => {
    const first = projectName(makeAgent({ name: "Support Bot", id: "aaaaaaaa" }))
    const second = projectName(makeAgent({ name: "Support Bot", id: "bbbbbbbb" }))

    expect(first).toBe("support-bot-aaaaaaaa")
    expect(second).toBe("support-bot-bbbbbbbb")
    expect(first).not.toBe(second)
  })

  it("only ever emits [a-z0-9-]", () => {
    const slug = projectName(
      makeAgent({ name: "Ünïcödé 你好 \t\n weirdchars" }),
    )
    expect(slug).toMatch(/^[a-z0-9-]*$/)
  })
})

// ---------------------------------------------------------------------------
// buildEveProject
// ---------------------------------------------------------------------------

describe("buildEveProject", () => {
  it("preserves every file from buildEveAgent (spread)", () => {
    const agent = makeAgent()
    const agentFiles = buildEveAgent(agent, empty)
    const projectFiles = buildEveProject(agent, empty)
    for (const [key, contents] of Object.entries(agentFiles)) {
      expect(projectFiles[key]).toBe(contents)
    }
  })

  it("adds package.json, tsconfig.json and .gitignore", () => {
    const files = buildEveProject(makeAgent(), empty)
    expect(files["package.json"]).toBeDefined()
    expect(files["tsconfig.json"]).toBeDefined()
    expect(files[".gitignore"]).toBeDefined()
  })

  it("emits a correct package.json", () => {
    const agent = makeAgent({ name: "Cool Agent" })
    const pkg = JSON.parse(buildEveProject(agent, empty)["package.json"])
    expect(pkg.name).toBe("cool-agent-12345678")
    expect(pkg.name).toBe(projectName(agent))
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.engines.node).toBe("24.x")
    expect(pkg.dependencies.eve).toBe(EVE_VERSION)
    // `ai` must satisfy eve's non-optional peer, or remote npm install fails with
    // ERESOLVE. Regression guard for the deploy bug we hit (pinned via the const).
    expect(pkg.dependencies.ai).toBe(EVE_AI_VERSION)
    expect(pkg.dependencies.zod).toBe(EVE_ZOD_VERSION)
    expect(pkg.scripts.build).toBe("eve build")
    expect(pkg.scripts.start).toBe("eve start")
    expect(pkg.scripts.dev).toBe("eve dev")
  })

  it("does NOT emit a vercel.json (eve owns the build output)", () => {
    const files = buildEveProject(makeAgent(), empty)
    expect(files["vercel.json"]).toBeUndefined()
  })

  it("emits valid JSON for package.json and tsconfig.json", () => {
    const files = buildEveProject(makeAgent(), empty)
    expect(() => JSON.parse(files["package.json"])).not.toThrow()
    expect(() => JSON.parse(files["tsconfig.json"])).not.toThrow()
  })

  // agent/instrumentation.ts is ALWAYS emitted (it imports `@vercel/otel`), so
  // the conditional dep guard always trips for every agent — no absent-case
  // test is needed. We assert it both via the exported const and the literal
  // pin (exact, not a caret range) so a silent version bump is a test failure,
  // mirroring the EVE_VERSION double-assert above.
  it("pins @vercel/otel for the always-emitted instrumentation.ts", () => {
    const pkg = JSON.parse(buildEveProject(makeAgent(), { connections: [] })["package.json"])
    expect(pkg.dependencies["@vercel/otel"]).toBe(EVE_OTEL_VERSION)
    expect(pkg.dependencies["@vercel/otel"]).toBe("2.1.3")
    expect(() => JSON.parse(buildEveProject(makeAgent(), { connections: [] })["package.json"])).not.toThrow()
  })

  it("does NOT add an @vercel/connect dependency even for an OAuth connection", () => {
    // OAuth connections now use the FM token broker (a plain fetch), not Vercel
    // Connect, so the generator must never declare @vercel/connect.
    const conn: Connection = {
      id: "conn-1",
      userId: "user-1",
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
    }
    const files = buildEveProject(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )
    const pkg = JSON.parse(files["package.json"])
    expect(pkg.dependencies["@vercel/connect"]).toBeUndefined()
    // And the emitted connection file no longer references Vercel Connect.
    expect(files["agent/connections/linear.ts"]).not.toContain("@vercel/connect")
  })

  it("adds @vercel/connect when a Vercel-Connect-backed connection (Slack) is assigned", () => {
    const conn: Connection = {
      id: "conn-slack",
      userId: "user-1",
      name: "Slack",
      transport: "http",
      url: "https://mcp.slack.com/mcp",
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
    }
    const files = buildEveProject(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )
    const pkg = JSON.parse(files["package.json"])
    expect(pkg.dependencies["@vercel/connect"]).toBe(EVE_CONNECT_VERSION)
    expect(files["agent/connections/slack.ts"]).toContain("@vercel/connect/eve")
  })

  describe("version opts", () => {
    it("defaults eve/ai pins to the module consts", () => {
      const pkg = JSON.parse(
        buildEveProject(makeAgent(), { connections: [] })["package.json"],
      )
      expect(pkg.dependencies.eve).toBe(EVE_VERSION)
      expect(pkg.dependencies.ai).toBe(EVE_AI_VERSION)
    })

    it("overrides eve/ai pins from opts (fleet version update)", () => {
      const pkg = JSON.parse(
        buildEveProject(makeAgent(), {
          connections: [],
          eveVersion: "0.16.2",
          aiVersion: "^7.1.0",
        })["package.json"],
      )
      expect(pkg.dependencies.eve).toBe("0.16.2")
      expect(pkg.dependencies.ai).toBe("^7.1.0")
    })

    // NOTE: "overrides eve/ai pins from opts" above already locks that the
    // candidate pin lands in package.json (the override + JSON.stringify
    // serialization pre-date this branch — see lib/eve/project.ts). The only
    // NEW behavior worth a dedicated test is injection-safety of a hostile pin.
    it("escapes a hostile pin value (JSON-safe, never code-injected)", () => {
      // A pin must NOT be string-interpolated into the generated package.json —
      // it is serialized via JSON.stringify, so even a value carrying quotes /
      // braces / a newline stays a quoted JSON string and never breaks out.
      const hostile = '0.17.0", "scripts": {"postinstall": "rm -rf /"}, "x": "'
      const raw = buildEveProject(makeAgent(), {
        connections: [],
        eveVersion: hostile,
      })["package.json"]
      // Still valid JSON (no breakout) and the value round-trips verbatim.
      expect(() => JSON.parse(raw)).not.toThrow()
      const pkg = JSON.parse(raw)
      expect(pkg.dependencies.eve).toBe(hostile)
      // The injected `postinstall` did NOT become a real script.
      expect(pkg.scripts.postinstall).toBeUndefined()
    })
  })
})
