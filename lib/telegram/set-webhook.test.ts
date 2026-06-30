import { describe, it, expect, vi } from "vitest"
import { setTelegramWebhook } from "./set-webhook"

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe("setTelegramWebhook", () => {
  it("POSTs to the bot setWebhook endpoint with the registration body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ ok: true, result: true }))
    await setTelegramWebhook({
      botToken: "123:abc",
      webhookSecretToken: "sek",
      url: "https://x.vercel.app/eve/v1/telegram",
      fetchImpl,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [endpoint, init] = fetchImpl.mock.calls[0]
    // The token lives in the PATH, never the body.
    expect(endpoint).toBe("https://api.telegram.org/bot123:abc/setWebhook")
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body)).toEqual({
      url: "https://x.vercel.app/eve/v1/telegram",
      secret_token: "sek",
      allowed_updates: ["message", "callback_query"],
    })
  })

  it("throws on a non-2xx HTTP response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, description: "bad gateway" }),
    } as unknown as Response)
    await expect(
      setTelegramWebhook({
        botToken: "123:abc",
        webhookSecretToken: "sek",
        url: "https://x.vercel.app/eve/v1/telegram",
        fetchImpl,
      }),
    ).rejects.toThrow(/502/)
  })

  it("throws when the response is 200 but ok !== true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ ok: false, error_code: 400, description: "bad request" }),
    )
    await expect(
      setTelegramWebhook({
        botToken: "123:abc",
        webhookSecretToken: "sek",
        url: "https://x.vercel.app/eve/v1/telegram",
        fetchImpl,
      }),
    ).rejects.toThrow(/bad request/)
  })

  it("never includes the bot token in a thrown error message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ ok: false, description: "nope" }),
    )
    let caught: unknown
    try {
      await setTelegramWebhook({
        botToken: "SECRET-TOKEN-123:abc",
        webhookSecretToken: "sek",
        url: "https://x.vercel.app/eve/v1/telegram",
        fetchImpl,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).not.toContain("SECRET-TOKEN-123:abc")
  })

  it("resolves without throwing on a successful registration", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ ok: true, result: true }))
    await expect(
      setTelegramWebhook({
        botToken: "123:abc",
        webhookSecretToken: "sek",
        url: "https://x.vercel.app/eve/v1/telegram",
        fetchImpl,
      }),
    ).resolves.toBeUndefined()
  })
})
