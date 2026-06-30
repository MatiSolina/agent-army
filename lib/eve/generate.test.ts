import { describe, it, expect } from "vitest"
import { buildEveAgent } from "./generate"
import type { Agent, Connection } from "@/lib/db/schema"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    userId: "user-1",
    name: "Soporte Bot",
    description: "Atiende clientes",
    model: "openai/gpt-4o-mini",
    systemPrompt: "Sos un agente de soporte amable y conciso.",
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

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
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
    ...overrides,
  }
}

const empty = { connections: [] }

// ---------------------------------------------------------------------------
// agent/agent.ts
// ---------------------------------------------------------------------------

describe("buildEveAgent — agent.ts", () => {
  it("emits agent/agent.ts with defineAgent and the gateway model id", () => {
    const files = buildEveAgent(makeAgent({ model: "openai/gpt-4o-mini" }), empty)
    const f = files["agent/agent.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { defineAgent } from "eve"')
    expect(f).toContain("export default defineAgent(")
    expect(f).toContain('model: "openai/gpt-4o-mini"')
  })

  it("does NOT serialize temperature into agent.ts (eve rejects the unknown key at build time)", () => {
    // eve@0.13.8's defineAgent has a strict public shape and fails `eve build`
    // on a top-level `temperature` under `modelOptions` ("Unknown key
    // \"temperature\""). The deployed agent must match eve's shape, so the
    // stored temperature is intentionally omitted from the generated config.
    const f = buildEveAgent(makeAgent({ temperature: 70 }), empty)["agent/agent.ts"]
    expect(f).not.toContain("temperature: 0.7")
    expect(f).not.toMatch(/modelOptions\s*:\s*\{/)
  })
})

// ---------------------------------------------------------------------------
// agent/instructions.md + dynamic runtime instructions
// ---------------------------------------------------------------------------

describe("buildEveAgent — runtime instructions", () => {
  it("keeps instructions.md as a stable bootstrap instead of baking the editable prompt", () => {
    const agent = makeAgent({ systemPrompt: "Sos un agente de soporte amable y conciso." })
    const files = buildEveAgent(agent, empty)
    expect(files["agent/instructions.md"]).toContain("Fleet Manager")
    expect(files["agent/instructions.md"]).not.toContain(agent.systemPrompt)
  })

  it("emits a dynamic runtime instructions resolver that fetches the active prompt every turn", () => {
    const agent = makeAgent({
      id: 'agent-"quoted"',
      systemPrompt: 'Fallback prompt with "quotes" and `ticks`.',
    })
    const files = buildEveAgent(agent, empty)
    const f = files["agent/instructions/runtime.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { defineDynamic, defineInstructions } from "eve/instructions"')
    expect(f).toContain('"turn.started"')
    expect(f).toContain("process.env.FM_BASE_URL")
    expect(f).toContain("process.env.EVE_AGENT_TOKEN")
    expect(f).toContain("/api/agents/")
    expect(f).toContain("/runtime-config")
    expect(f).toContain(JSON.stringify(agent.id))
    expect(f).toContain(JSON.stringify(agent.systemPrompt))
    expect(f).toContain("defineInstructions({ markdown")
  })
})

// ---------------------------------------------------------------------------
// agent/skills/<slug>.md
// ---------------------------------------------------------------------------

describe("buildEveAgent — skills", () => {
  it("writes one markdown skill file per skill with description frontmatter + content", () => {
    const agent = makeAgent({
      skills: [
        {
          id: "sk1",
          name: "Release Checklist",
          description: "Use when the user needs a release checklist.",
          content: "1. Cut a tag\n2. Update changelog",
        },
      ],
    })
    const files = buildEveAgent(agent, empty)
    const f = files["agent/skills/release_checklist.md"]
    expect(f).toBeDefined()
    expect(f).toContain("---")
    // Description is emitted as a quoted YAML scalar (JSON.stringify), which is
    // valid YAML and injection-safe.
    expect(f).toContain(
      'description: "Use when the user needs a release checklist."',
    )
    expect(f).toContain("1. Cut a tag")
  })

  it("escapes skill descriptions so they cannot break or inject YAML frontmatter", () => {
    const agent = makeAgent({
      skills: [
        {
          id: "sk1",
          name: "Sneaky",
          // Newline + a forged YAML key + a frontmatter terminator: a raw
          // interpolation would corrupt the frontmatter / inject a key.
          description: 'oops\ninjected: true\n---\nrole: system',
          content: "body",
        },
      ],
    })
    const f = buildEveAgent(agent, empty)["agent/skills/sneaky.md"]
    expect(f).toBeDefined()
    // The description occupies exactly one frontmatter line, fully quoted; the
    // payload is escaped (no literal newline, no bare injected key, no stray ---).
    expect(f).toContain(
      'description: "oops\\ninjected: true\\n---\\nrole: system"',
    )
    expect(f).not.toContain("\ninjected: true")
  })
})

// ---------------------------------------------------------------------------
// agent/connections/<slug>.ts
// ---------------------------------------------------------------------------

describe("buildEveAgent — connections", () => {
  it("oauth catalog connection → defineMcpClientConnection with a getToken broker fetch (no Vercel Connect)", () => {
    const conn = makeConnection({
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      token: null,
    })
    const files = buildEveAgent(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )
    const f = files["agent/connections/linear.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { defineMcpClientConnection } from "eve/connections"')
    expect(f).toContain('url: "https://mcp.linear.app/mcp"')
    // FM token broker: getToken fetches the Fleet Manager's token endpoint with
    // this agent's per-agent EVE_AGENT_TOKEN bearer + &agent; no Vercel Connect.
    expect(f).toContain("getToken")
    expect(f).toContain("process.env.FM_BASE_URL")
    expect(f).toContain("/api/mcp/token?conn=")
    expect(f).toContain("&agent=")
    expect(f).toContain("process.env.EVE_AGENT_TOKEN")
    expect(f).toContain("Bearer")
    expect(f).not.toContain("@vercel/connect")
  })

  it("Vercel-Connect-backed connection (catalog vercelConnect) → auth: connect(uid), no FM broker", () => {
    // Slack's MCP OAuth has no Dynamic Client Registration, so it can't use the
    // DCR broker. Vercel Connect supports Slack natively; the catalog marks it
    // vercelConnect:"slack" and the generator emits eve's connect() helper.
    const conn = makeConnection({
      name: "Slack",
      url: "https://mcp.slack.com/mcp",
      token: null,
    })
    const files = buildEveAgent(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )
    const f = files["agent/connections/slack.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { connect } from "@vercel/connect/eve"')
    expect(f).toContain('import { defineMcpClientConnection } from "eve/connections"')
    expect(f).toContain('url: "https://mcp.slack.com/mcp"')
    expect(f).toContain('auth: connect("slack/agentarmy")')
    // Connect brokers the token — NOT our FM broker.
    expect(f).not.toContain("/api/mcp/token")
    expect(f).not.toContain("getToken")
  })

  it("oauth connection escapes conn.id via q() so it cannot break out of the emitted source", () => {
    // A connection id carrying quotes/backtick must be JSON-escaped in the
    // emitted source (q()), never interpolated raw into the URL template.
    const nastyId = 'c"1`x'
    const conn = makeConnection({
      id: nastyId,
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      token: null,
    })
    const f = buildEveAgent(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )["agent/connections/linear.ts"]
    expect(f).toBeDefined()
    // The id appears only in its JSON-escaped form, e.g. "c\"1`x".
    expect(f).toContain(JSON.stringify(nastyId))
    // The raw, unescaped id must NOT appear (would break the template literal).
    expect(f).not.toContain(`conn=${nastyId}`)
  })

  it("static-token connection → getToken returning an env var, no connect()", () => {
    const conn = makeConnection({
      id: "conn-hf",
      name: "Hugging Face",
      url: "https://huggingface.co/mcp",
      token: "hf_xxx",
    })
    const files = buildEveAgent(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )
    const f = files["agent/connections/hugging_face.ts"]
    expect(f).toBeDefined()
    expect(f).toContain("getToken")
    expect(f).toContain("process.env")
    expect(f).not.toContain("@vercel/connect/eve")
  })

  it("no-auth connection (no token, not oauth catalog) → no auth field", () => {
    const conn = makeConnection({
      id: "conn-ctx",
      name: "Context7",
      url: "https://mcp.context7.com/mcp",
      token: null,
    })
    const files = buildEveAgent(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )
    const f = files["agent/connections/context7.ts"]
    expect(f).toBeDefined()
    expect(f).not.toContain("auth:")
    expect(f).not.toContain("@vercel/connect/eve")
  })

  it("stdio connections are skipped (not remote)", () => {
    const conn = makeConnection({
      id: "conn-stdio",
      name: "Local Tool",
      transport: "stdio",
      url: "",
      token: null,
    })
    const files = buildEveAgent(
      makeAgent({ connectionIds: [conn.id] }),
      { connections: [conn] },
    )
    expect(files["agent/connections/local_tool.ts"]).toBeUndefined()
    const connKeys = Object.keys(files).filter((k) => k.startsWith("agent/connections/"))
    expect(connKeys).toHaveLength(0)
  })

  it("only resolves connections referenced by connectionIds", () => {
    const assigned = makeConnection({ id: "c-assigned", name: "Linear", url: "https://mcp.linear.app/mcp" })
    const other = makeConnection({ id: "c-other", name: "Stripe", url: "https://mcp.stripe.com" })
    const files = buildEveAgent(
      makeAgent({ connectionIds: ["c-assigned"] }),
      { connections: [assigned, other] },
    )
    expect(files["agent/connections/linear.ts"]).toBeDefined()
    expect(files["agent/connections/stripe.ts"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// agent/subagents/<id>/
// ---------------------------------------------------------------------------

describe("buildEveAgent — subagents", () => {
  it("one subagent dir per subagent: agent.ts (with description) + instructions.md", () => {
    const agent = makeAgent({
      subagents: [
        {
          id: "researcher",
          name: "Investigador",
          model: "anthropic/claude-opus-4.8",
          instructions: "Investigá a fondo antes de responder.",
        },
      ],
    })
    const files = buildEveAgent(agent, empty)
    const cfg = files["agent/subagents/investigador/agent.ts"]
    const ins = files["agent/subagents/investigador/instructions.md"]
    expect(cfg).toBeDefined()
    expect(cfg).toContain('import { defineAgent } from "eve"')
    expect(cfg).toContain('model: "anthropic/claude-opus-4.8"')
    expect(cfg).toContain("description:")
    expect(ins).toBe("Investigá a fondo antes de responder.")
  })
})

// ---------------------------------------------------------------------------
// agent/schedules/<slug>.md
// ---------------------------------------------------------------------------

describe("buildEveAgent — schedules", () => {
  it("one schedule file per schedule, with cron frontmatter + prompt body", () => {
    const agent = makeAgent({
      schedules: [
        {
          id: "s1",
          name: "Daily Digest",
          cron: "0 9 * * 1-5",
          prompt: "Resumí la actividad de ayer.",
          enabled: true,
        },
      ],
    })
    const files = buildEveAgent(agent, empty)
    const f = files["agent/schedules/daily_digest.md"]
    expect(f).toBeDefined()
    expect(f).toContain('cron: "0 9 * * 1-5"')
    expect(f).toContain("Resumí la actividad de ayer.")
  })
})

// ---------------------------------------------------------------------------
// agent/sandbox.ts
// ---------------------------------------------------------------------------

describe("buildEveAgent — sandbox", () => {
  it("sandbox.enabled=false → no sandbox file", () => {
    const files = buildEveAgent(makeAgent({ sandbox: { enabled: false } }), empty)
    expect(files["agent/sandbox.ts"]).toBeUndefined()
  })

  it("sandbox.enabled=true → defineSandbox with vercel backend + runtime + bootstrap setupCommands", () => {
    const agent = makeAgent({
      sandbox: {
        enabled: true,
        runtime: "node24",
        setupCommands: "apt-get install -y jq\npip install requests",
      },
    })
    const files = buildEveAgent(agent, empty)
    const f = files["agent/sandbox.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { defineSandbox } from "eve/sandbox"')
    expect(f).toContain("vercel(")
    expect(f).toContain('runtime: "node24"')
    expect(f).toContain("bootstrap")
    expect(f).toContain("apt-get install -y jq")
  })
})

// ---------------------------------------------------------------------------
// agent/channels/kapso.ts
// ---------------------------------------------------------------------------

describe("buildEveAgent — kapso channel", () => {
  it("always emits a custom kapso WhatsApp channel using defineChannel", () => {
    const files = buildEveAgent(makeAgent(), empty)
    const f = files["agent/channels/kapso.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { defineChannel, GET, POST } from "eve/channels"')
    expect(f).toContain("export default defineChannel(")
    // webhook POST route + signature verification + send()
    expect(f).toContain('POST("/kapso/webhook"')
    expect(f).toContain("send(")
    expect(f).toMatch(/signature|secret/i)
  })

  it("parses both Kapso-native and Meta-Graph inbound message shapes", () => {
    const f = buildEveAgent(makeAgent(), empty)["agent/channels/kapso.ts"]
    // Meta-Graph shape: entry[].changes[].value.messages[]
    expect(f).toContain("entry")
    expect(f).toContain("changes")
    expect(f).toContain("messages")
    // WhatsApp text body lives at message.text.body, sender at message.from
    expect(f).toContain("text")
    expect(f).toContain(".body")
    // Kapso-native batched shape uses payload.data[] / event.message
    expect(f).toMatch(/data\b/)
  })

  it("answers the Meta/Kapso GET subscription-verification handshake (hub.challenge)", () => {
    const f = buildEveAgent(makeAgent(), empty)["agent/channels/kapso.ts"]
    expect(f).toContain('import { defineChannel, GET, POST } from "eve/channels"')
    expect(f).toContain('GET("/kapso/webhook"')
    expect(f).toContain("hub.challenge")
  })

  it("verifies the Kapso webhook signature with HMAC-SHA256 and the right headers", () => {
    const f = buildEveAgent(makeAgent(), empty)["agent/channels/kapso.ts"]
    expect(f).toContain("createHmac")
    expect(f).toContain('"sha256"')
    expect(f).toContain("timingSafeEqual")
    // Kapso signs with x-webhook-signature; Meta uses x-hub-signature-256.
    expect(f).toContain("x-webhook-signature")
    expect(f).toContain("x-hub-signature-256")
    expect(f).toContain("KAPSO_WEBHOOK_SECRET")
    expect(f).toContain("if (!secret) return false")
    expect(f).not.toContain("if (!secret) return true")
  })

  it("starts a session with the kapso authenticator keyed on the sender", () => {
    const f = buildEveAgent(makeAgent(), empty)["agent/channels/kapso.ts"]
    expect(f).toContain('authenticator: "kapso"')
    expect(f).toContain('principalType: "user"')
    expect(f).toContain("principalId")
    expect(f).toContain("continuationToken")
  })

  it("has a message.completed handler that guards tool-call narration and replies via Kapso", () => {
    const f = buildEveAgent(makeAgent(), empty)["agent/channels/kapso.ts"]
    expect(f).toContain('"message.completed"')
    expect(f).toContain('finishReason === "tool-calls"')
    expect(f).toContain("eventData.message")
    // recipient comes from the session initiator (the sender we set above)
    expect(f).toMatch(/ctx\??\.session\??\.auth/)
    expect(f).toContain("initiator")
  })

  it("sends replies through the real Kapso WhatsApp Cloud proxy endpoint", () => {
    const f = buildEveAgent(makeAgent(), empty)["agent/channels/kapso.ts"]
    // Real endpoint from @kapso/chat-adapter -> @kapso/whatsapp-cloud-api:
    //   POST https://api.kapso.ai/meta/whatsapp/v23.0/{phoneNumberId}/messages
    expect(f).toContain("https://api.kapso.ai/meta/whatsapp")
    expect(f).toContain("/messages")
    // Auth header is X-API-Key (not Bearer), per the whatsapp-cloud-api client.
    expect(f).toContain("X-API-Key")
    expect(f).toContain("KAPSO_API_KEY")
    expect(f).toContain("KAPSO_PHONE_NUMBER_ID")
    // WhatsApp Cloud message envelope.
    expect(f).toContain('messaging_product')
    expect(f).toContain('"text"')
  })
})

// ---------------------------------------------------------------------------
// agent/channels/slack.ts (Vercel-Connect-backed, eve-native slackChannel)
// ---------------------------------------------------------------------------

describe("buildEveAgent — slack channel (type-aware)", () => {
  it("emits the eve-native slack channel when the assigned channel is slack", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "slack", slackConnectUid: "slack/soporte" },
    })
    const f = files["agent/channels/slack.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { slackChannel } from "eve/channels/slack"')
    expect(f).toContain('import { connectSlackCredentials } from "@vercel/connect/eve"')
    expect(f).toContain("export default slackChannel(")
    // The connector UID is injected JSON-escaped (q()) — no raw interpolation.
    expect(f).toContain('connectSlackCredentials("slack/soporte")')
  })

  it("does NOT emit the kapso channel when the assigned channel is slack", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "slack", slackConnectUid: "slack/soporte" },
    })
    expect(files["agent/channels/kapso.ts"]).toBeUndefined()
    expect(files["agent/channels/slack.ts"]).toBeDefined()
    // The eve proxy channel is always present regardless of inbound channel.
    expect(files["agent/channels/eve.ts"]).toBeDefined()
  })

  it("escapes the connector UID injection-safely", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "slack", slackConnectUid: 'slack/x") evil(' },
    })
    const f = files["agent/channels/slack.ts"]
    // q()=JSON.stringify neutralizes the quote/paren break-out.
    expect(f).toContain('connectSlackCredentials("slack/x\\") evil(")')
    expect(f).not.toContain('connectSlackCredentials("slack/x") evil(")')
  })

  it("throws when a slack channel has no connector UID", () => {
    expect(() =>
      buildEveAgent(makeAgent(), {
        connections: [],
        channel: { type: "slack", slackConnectUid: null },
      }),
    ).toThrow(/connect/i)
  })

  it("emits kapso (not slack) for a kapso-typed channel and for no channel", () => {
    const kapso = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "kapso" },
    })
    expect(kapso["agent/channels/kapso.ts"]).toBeDefined()
    expect(kapso["agent/channels/slack.ts"]).toBeUndefined()

    const none = buildEveAgent(makeAgent(), empty)
    expect(none["agent/channels/kapso.ts"]).toBeDefined()
    expect(none["agent/channels/slack.ts"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// agent/channels/telegram.ts (eve-native telegramChannel, env-backed secrets)
// ---------------------------------------------------------------------------

describe("buildEveAgent — telegram channel (type-aware)", () => {
  it("emits the eve-native telegram channel when the assigned channel is telegram", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "telegram", telegramBotUsername: "my_bot" },
    })
    const f = files["agent/channels/telegram.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { telegramChannel } from "eve/channels/telegram"')
    expect(f).toContain("export default telegramChannel(")
    // The bot username is injected JSON-escaped (q()) — no raw interpolation.
    expect(f).toContain('botUsername: "my_bot"')
  })

  it("does NOT emit kapso or slack when the assigned channel is telegram", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "telegram", telegramBotUsername: "my_bot" },
    })
    expect(files["agent/channels/kapso.ts"]).toBeUndefined()
    expect(files["agent/channels/slack.ts"]).toBeUndefined()
    expect(files["agent/channels/telegram.ts"]).toBeDefined()
    // The eve proxy channel is always present regardless of inbound channel.
    expect(files["agent/channels/eve.ts"]).toBeDefined()
  })

  it("escapes the bot username injection-safely", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "telegram", telegramBotUsername: 'a"})\nmalicious(' },
    })
    const f = files["agent/channels/telegram.ts"]
    // q()=JSON.stringify neutralizes the quote/brace/newline break-out: the
    // username only ever appears as a JSON-escaped string literal.
    expect(f).toContain(`botUsername: ${JSON.stringify('a"})\nmalicious(')}`)
    expect(f).not.toContain("\nmalicious(")
  })

  it("emits telegramChannel({}) with no botUsername key when username is absent", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "telegram" },
    })
    const f = files["agent/channels/telegram.ts"]
    expect(f).toBeDefined()
    expect(f).toContain("export default telegramChannel({})")
    expect(f).not.toContain("botUsername")
  })

  it("falls back to kapso for an unknown channel type", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "mystery" },
    })
    expect(files["agent/channels/kapso.ts"]).toBeDefined()
    expect(files["agent/channels/telegram.ts"]).toBeUndefined()
    expect(files["agent/channels/slack.ts"]).toBeUndefined()
  })

  it("emits exactly one inbound channel for a telegram-typed channel", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "telegram", telegramBotUsername: "my_bot" },
    })
    const inbound = ["kapso.ts", "slack.ts", "telegram.ts"].filter(
      (name) => files[`agent/channels/${name}`] !== undefined,
    )
    expect(inbound).toEqual(["telegram.ts"])
  })
})

// ---------------------------------------------------------------------------
// agent/channels/discord.ts (eve-native discordChannel, env-backed secrets)
// ---------------------------------------------------------------------------

describe("buildEveAgent — discord channel (type-aware)", () => {
  it("emits the eve-native discord channel when the assigned channel is discord", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "discord" },
    })
    const f = files["agent/channels/discord.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { discordChannel } from "eve/channels/discord"')
    expect(f).toContain("export default discordChannel()")
  })

  it("emits a fixed constant with zero interpolation of any DB value", () => {
    // Discord threads no structural/non-secret param, so the file is a fixed
    // two-line constant. The three secrets are read from process.env at runtime,
    // never baked in. Assert the EXACT expected string (no interpolation).
    const expected =
      'import { discordChannel } from "eve/channels/discord"\n\nexport default discordChannel()\n'
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "discord" },
    })
    expect(files["agent/channels/discord.ts"]).toBe(expected)
    // No secret/option object is ever present (no-arg form).
    expect(files["agent/channels/discord.ts"]).not.toContain("credentials")
    expect(files["agent/channels/discord.ts"]).not.toContain("DISCORD_")
  })

  it("does NOT emit kapso/slack/telegram when the assigned channel is discord", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "discord" },
    })
    expect(files["agent/channels/kapso.ts"]).toBeUndefined()
    expect(files["agent/channels/slack.ts"]).toBeUndefined()
    expect(files["agent/channels/telegram.ts"]).toBeUndefined()
    expect(files["agent/channels/discord.ts"]).toBeDefined()
    // The eve proxy channel is always present regardless of inbound channel.
    expect(files["agent/channels/eve.ts"]).toBeDefined()
  })

  it("still falls back to kapso for an unknown channel type", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "mystery" },
    })
    expect(files["agent/channels/kapso.ts"]).toBeDefined()
    expect(files["agent/channels/discord.ts"]).toBeUndefined()
  })

  it("emits exactly one inbound channel for a discord-typed channel", () => {
    const files = buildEveAgent(makeAgent(), {
      connections: [],
      channel: { type: "discord" },
    })
    const inbound = ["kapso.ts", "slack.ts", "telegram.ts", "discord.ts"].filter(
      (name) => files[`agent/channels/${name}`] !== undefined,
    )
    expect(inbound).toEqual(["discord.ts"])
  })
})

// Custom Tools are MCP-only now: the dashboard no longer compiles schema-only
// tool stubs into the deployed agent (they were no-op "not implemented" stubs).
// Tools come exclusively from assigned MCP connections, so buildEveAgent emits
// no agent/tools/ files.
describe("buildEveAgent — no custom tool stubs", () => {
  it("never emits any agent/tools/ files", () => {
    const files = buildEveAgent(makeAgent({ toolIds: ["t1", "t2"] }), empty)
    const toolKeys = Object.keys(files).filter((k) => k.startsWith("agent/tools/"))
    expect(toolKeys).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Full directory shape
// ---------------------------------------------------------------------------

describe("buildEveAgent — full shape", () => {
  it("a minimal agent always has agent.ts, instructions.md, and the kapso channel", () => {
    const files = buildEveAgent(makeAgent(), empty)
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "agent/agent.ts",
        "agent/instructions.md",
        "agent/channels/kapso.ts",
        "agent/instrumentation.ts",
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// Tier-1 OTel: agent/instrumentation.ts
// ---------------------------------------------------------------------------

// eve auto-discovers agent/instrumentation.ts and its mere presence implicitly
// enables telemetry (no isEnabled toggle). We always emit the bare vanilla
// registerOTel shape from the eve docs (instrumentation.md): auto-resolved
// service name, NO hardcoded name, NO traceExporter, NO env secret — Vercel's
// OIDC handles export. No user/config string is interpolated into this file, so
// there is nothing to escape (hence no injection test for it).
describe("buildEveAgent — instrumentation.ts (Tier-1 OTel)", () => {
  it("always emits agent/instrumentation.ts with the bare registerOTel shape", () => {
    const files = buildEveAgent(makeAgent(), { connections: [] })
    const f = files["agent/instrumentation.ts"]
    expect(f).toBeDefined()
    expect(f).toContain("eve/instrumentation")
    expect(f).toContain("@vercel/otel")
    expect(f).toContain("registerOTel")
    expect(f).toContain("defineInstrumentation")
  })
})

describe("no code injection into generated source", () => {
  it("escapes string-literal fields (newlines/quotes) so they cannot break out", () => {
    const model = 'openai/gpt"\n"); process.exit(1); ("'
    const ts = buildEveAgent(makeAgent({ model }), {
      connections: [],
    })["agent/agent.ts"]
    // The value appears ONLY as a JSON-escaped literal — it cannot break out
    // into executable code (process.exit etc. stays inert string data).
    expect(ts).toContain(JSON.stringify(model))
  })

  it("sanitizes user values interpolated into comments (no comment break-out)", () => {
    const name = "X\nexport const HACKED = 1 //"
    const ts = buildEveAgent(makeAgent({ name }), {
      connections: [],
    })["agent/agent.ts"]
    expect(ts).not.toMatch(/^export const HACKED/m)
  })

  it("safely serializes a malicious connection url", () => {
    const conn = makeConnection({ id: "c1", url: 'https://x"\n}); fetch("evil"); ({' })
    const files = buildEveAgent(makeAgent({ connectionIds: ["c1"] }), {
      connections: [conn],
    })
    const path = Object.keys(files).find((p) => p.startsWith("agent/connections/"))!
    expect(files[path]).toContain(JSON.stringify(conn.url))
    expect(files[path]).not.toMatch(/fetch\("evil"\)/)
  })
})

// ---------------------------------------------------------------------------
// Harness guardrails — disable built-in tools via agent/tools/<slug>.ts
// ---------------------------------------------------------------------------

describe("buildEveAgent — harness guardrails", () => {
  // Eve's built-in tools (bash, file tools, web) ship with every agent and the
  // model can call them unless we author a `disableTool()` file at the tool's
  // slug. A customer-support bot must NOT be able to run shell or touch a FS, so
  // each `false` flag emits exactly that file. See concepts/default-harness.

  it("emits NO tool-disable files for the default harness (every flag on)", () => {
    const files = buildEveAgent(makeAgent({ harness: {} }), empty)
    const toolFiles = Object.keys(files).filter((p) => p.startsWith("agent/tools/"))
    expect(toolFiles).toEqual([])
  })

  it("disables bash when harness.bash is false", () => {
    const files = buildEveAgent(makeAgent({ harness: { bash: false } }), empty)
    const f = files["agent/tools/bash.ts"]
    expect(f).toBeDefined()
    expect(f).toContain('import { disableTool } from "eve/tools"')
    expect(f).toContain("export default disableTool()")
    // Only bash — the other built-ins stay on.
    expect(files["agent/tools/web_fetch.ts"]).toBeUndefined()
  })

  it("disables all four file tools when harness.files is false", () => {
    const files = buildEveAgent(makeAgent({ harness: { files: false } }), empty)
    for (const slug of ["read_file", "write_file", "glob", "grep"]) {
      expect(files[`agent/tools/${slug}.ts`]).toContain("export default disableTool()")
    }
    expect(files["agent/tools/bash.ts"]).toBeUndefined()
  })

  it("disables web_fetch and web_search independently", () => {
    const fetchOff = buildEveAgent(makeAgent({ harness: { webFetch: false } }), empty)
    expect(fetchOff["agent/tools/web_fetch.ts"]).toContain("export default disableTool()")
    expect(fetchOff["agent/tools/web_search.ts"]).toBeUndefined()

    const searchOff = buildEveAgent(makeAgent({ harness: { webSearch: false } }), empty)
    expect(searchOff["agent/tools/web_search.ts"]).toContain("export default disableTool()")
    expect(searchOff["agent/tools/web_fetch.ts"]).toBeUndefined()
  })

  it("locks down a customer-support bot: all built-in tools disabled, MCP connection kept", () => {
    const conn = makeConnection({ id: "c1" })
    const files = buildEveAgent(
      makeAgent({
        connectionIds: ["c1"],
        harness: { bash: false, files: false, webFetch: false, webSearch: false },
      }),
      { connections: [conn] },
    )
    for (const slug of ["bash", "read_file", "write_file", "glob", "grep", "web_fetch", "web_search"]) {
      expect(files[`agent/tools/${slug}.ts`]).toContain("export default disableTool()")
    }
    // The MCP connection is its capability surface and must survive.
    expect(Object.keys(files).some((p) => p.startsWith("agent/connections/"))).toBe(true)
  })

  it("forces sandbox networkPolicy deny-all when bash is disabled", () => {
    // Defense in depth: with no shell tool the model has no reason to reach the
    // network from the sandbox, so close egress when the sandbox is authored.
    const files = buildEveAgent(
      makeAgent({ sandbox: { enabled: true }, harness: { bash: false } }),
      empty,
    )
    // Must sit ON the backend factory — eve's defineSandbox rejects a top-level
    // `networkPolicy` key ("Unknown key networkPolicy"), which fails the build.
    expect(files["agent/sandbox.ts"]).toContain(
      'vercel({ runtime: "node24", networkPolicy: "deny-all" })',
    )
    expect(files["agent/sandbox.ts"]).not.toMatch(/\}\),\s*\n\s*networkPolicy:/)
  })

  it("leaves sandbox egress at the default when bash is enabled", () => {
    const files = buildEveAgent(
      makeAgent({ sandbox: { enabled: true }, harness: {} }),
      empty,
    )
    expect(files["agent/sandbox.ts"]).not.toContain("deny-all")
  })
})
