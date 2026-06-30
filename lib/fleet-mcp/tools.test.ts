import { describe, expect, it, vi } from "vitest"
import {
  requireFleetMcpScope,
  runAuditedFleetTool,
  toSafeAgentConfig,
  toSafeSecretStatus,
} from "./tools"

const auth = {
  token: "fmcp_at_test",
  clientId: "client-1",
  scopes: ["fleet:read", "deploy:write"],
  expiresAt: 1,
  resource: "https://fm.test/api/fleet-mcp",
  extra: { userId: "demo-user" },
}

describe("Fleet MCP tool guardrails", () => {
  it("enforces per-tool scopes from xmcp authInfo", () => {
    expect(() =>
      requireFleetMcpScope({ authInfo: auth }, "fleet:read"),
    ).not.toThrow()
    expect(() =>
      requireFleetMcpScope({ authInfo: auth }, "agent:write"),
    ).toThrow(/scope/i)
  })

  it("projects agent config without legacy token-bearing fields", () => {
    const safe = toSafeAgentConfig({
      id: "a1",
      name: "Support",
      description: "Handles support",
      model: "openai/gpt-4o-mini",
      instructions: "Help",
      systemPrompt: "System",
      temperature: 70,
      maxSteps: 10,
      enabled: true,
      skills: [],
      toolIds: ["legacy-tool"],
      connectionIds: ["conn-1"],
      subagents: [],
      schedules: [],
      sandbox: { enabled: false },
      harness: {},
      token: "must-not-leak",
      connections: [{ id: "inline", token: "must-not-leak" }],
    })

    expect(JSON.stringify(safe)).not.toContain("must-not-leak")
    expect(safe).not.toHaveProperty("connections")
  })

  it("returns only presence for secret status, never values", () => {
    expect(
      toSafeSecretStatus([
        { key: "TELEGRAM_BOT_TOKEN", present: true, value: "secret" },
      ]),
    ).toEqual([{ key: "TELEGRAM_BOT_TOKEN", present: true }])
  })

  it("writes an audit log for successful and failed tool calls", async () => {
    const writeAuditLog = vi.fn(async () => {})

    await expect(
      runAuditedFleetTool(
        { authInfo: auth },
        {
          toolName: "fleet-list-agents",
          requiredScope: "fleet:read",
          writeAuditLog,
        },
        async () => "ok",
      ),
    ).resolves.toBe("ok")

    await expect(
      runAuditedFleetTool(
        { authInfo: auth },
        {
          toolName: "fleet-update-agent-config",
          requiredScope: "agent:write",
          writeAuditLog,
        },
        async () => "never",
      ),
    ).rejects.toThrow(/scope/i)

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "fleet-list-agents", status: "ok" }),
    )
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "fleet-update-agent-config",
        status: "error",
      }),
    )
  })
})
