import { describe, it, expect, vi } from "vitest"
import { setDiscordInteractionsEndpoint } from "./set-interactions-endpoint"

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe("setDiscordInteractionsEndpoint", () => {
  it("PATCHes the application endpoint with the URL in the body and the token in a header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: "app-id" }))
    await setDiscordInteractionsEndpoint({
      botToken: "bot-tok",
      applicationId: "app-id",
      url: "https://x.vercel.app/eve/v1/discord",
      fetchImpl,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [endpoint, init] = fetchImpl.mock.calls[0]
    // The application id lives in the PATH.
    expect(endpoint).toBe("https://discord.com/api/v10/applications/app-id")
    expect(init.method).toBe("PATCH")
    // The bot token lives in the Authorization HEADER, never the path/body.
    expect(init.headers.Authorization).toBe("Bot bot-tok")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body)).toEqual({
      interactions_endpoint_url: "https://x.vercel.app/eve/v1/discord",
    })
  })

  it("throws on a 401 unauthorized response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "401: Unauthorized" }),
    } as unknown as Response)
    await expect(
      setDiscordInteractionsEndpoint({
        botToken: "bot-tok",
        applicationId: "app-id",
        url: "https://x.vercel.app/eve/v1/discord",
        fetchImpl,
      }),
    ).rejects.toThrow(/401/)
  })

  it("throws on Discord's PING-validation failure (400)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        message: "interactions endpoint url could not be verified",
      }),
    } as unknown as Response)
    await expect(
      setDiscordInteractionsEndpoint({
        botToken: "bot-tok",
        applicationId: "app-id",
        url: "https://x.vercel.app/eve/v1/discord",
        fetchImpl,
      }),
    ).rejects.toThrow(/could not be verified/)
  })

  it("never includes the bot token in a thrown error message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "nope" }),
    } as unknown as Response)
    let caught: unknown
    try {
      await setDiscordInteractionsEndpoint({
        botToken: "SECRET-BOT-TOKEN-xyz",
        applicationId: "app-id",
        url: "https://x.vercel.app/eve/v1/discord",
        fetchImpl,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).not.toContain("SECRET-BOT-TOKEN-xyz")
  })

  it("resolves undefined on a successful registration", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: "app-id" }))
    await expect(
      setDiscordInteractionsEndpoint({
        botToken: "bot-tok",
        applicationId: "app-id",
        url: "https://x.vercel.app/eve/v1/discord",
        fetchImpl,
      }),
    ).resolves.toBeUndefined()
  })
})
