import { describe, expect, it, vi } from "vitest"
import { listKapsoPhoneNumbers, registerKapsoWebhook } from "./kapso"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// One full entry as the Platform API returns it (only fields we read matter).
function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "kapso-internal",
    phone_number_id: "1122334455",
    display_phone_number: "+54 9 11 5555-5555",
    verified_name: "Acme Support",
    display_name: null,
    status: "CONNECTED",
    ...overrides,
  }
}

describe("listKapsoPhoneNumbers", () => {
  it("maps each entry to the phone_number_id, a human label, and status", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [entry()], meta: { total_count: 1 } }),
    ) as unknown as typeof fetch

    const result = await listKapsoPhoneNumbers("key", fetchImpl)

    expect(result).toEqual([
      {
        phoneNumberId: "1122334455",
        phoneNumber: "+54 9 11 5555-5555",
        label: "+54 9 11 5555-5555 · Acme Support",
        status: "CONNECTED",
      },
    ])
  })

  it("exposes the display phone number (null when Kapso has none)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [entry({ display_phone_number: null })],
      }),
    ) as unknown as typeof fetch
    const [pn] = await listKapsoPhoneNumbers("key", fetchImpl)
    expect(pn.phoneNumber).toBeNull()
  })

  it("falls back to the phone_number_id when there is no display label", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          entry({
            display_phone_number: null,
            verified_name: null,
            display_name: null,
          }),
        ],
      }),
    ) as unknown as typeof fetch

    const [pn] = await listKapsoPhoneNumbers("key", fetchImpl)
    expect(pn.label).toBe("1122334455")
  })

  it("returns an empty list when the project has no numbers", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [], meta: { total_count: 0 } }),
    ) as unknown as typeof fetch

    expect(await listKapsoPhoneNumbers("key", fetchImpl)).toEqual([])
  })

  it("calls the Platform phone-numbers endpoint with the X-API-Key header", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [] }),
    ) as unknown as typeof fetch

    await listKapsoPhoneNumbers("secret-key", fetchImpl)

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]
    expect(url).toBe("https://api.kapso.ai/platform/v1/whatsapp/phone_numbers")
    expect((init as RequestInit).headers).toMatchObject({
      "X-API-Key": "secret-key",
    })
  })

  it("throws a helpful error when the key is rejected (401)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized" }, 401),
    ) as unknown as typeof fetch

    await expect(listKapsoPhoneNumbers("bad", fetchImpl)).rejects.toThrow(/401/)
  })

  it("rejects a blank API key without hitting the network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(listKapsoPhoneNumbers("  ", fetchImpl)).rejects.toThrow(
      /api key/i,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("registerKapsoWebhook", () => {
  const URL = "https://bot-a1.vercel.app/kapso/webhook"

  it("creates a webhook (POST) when none points at the URL yet", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) =>
      (init.method ?? "GET") === "GET"
        ? jsonResponse({ data: [] })
        : jsonResponse({ id: "wh1" }, 201),
    ) as unknown as typeof fetch

    await registerKapsoWebhook({
      apiKey: "key",
      phoneNumberId: "PN1",
      url: URL,
      secret: "shh",
      fetchImpl,
    })

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    const [postUrl, postInit] = calls.find(
      (c) => (c[1] as RequestInit)?.method === "POST",
    )!
    expect(postUrl).toBe(
      "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/PN1/webhooks",
    )
    expect((postInit as RequestInit).headers).toMatchObject({
      "X-API-Key": "key",
    })
    expect(JSON.parse(String((postInit as RequestInit).body))).toEqual({
      whatsapp_webhook: {
        url: URL,
        secret_key: "shh",
        events: ["whatsapp.message.received"],
        active: true,
      },
    })
  })

  it("updates the existing webhook (PATCH) for the URL — never duplicates", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) =>
      (init.method ?? "GET") === "GET"
        ? jsonResponse({ data: [{ id: "wh-existing", url: URL }] })
        : jsonResponse({ id: "wh-existing" }),
    ) as unknown as typeof fetch

    await registerKapsoWebhook({
      apiKey: "key",
      phoneNumberId: "PN1",
      url: URL,
      secret: "rotated",
      fetchImpl,
    })

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    const patch = calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")!
    expect(patch[0]).toBe(
      "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/PN1/webhooks/wh-existing",
    )
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({
      whatsapp_webhook: { secret_key: "rotated", active: true },
    })
    expect(calls.some((c) => (c[1] as RequestInit)?.method === "POST")).toBe(
      false,
    )
  })

  it("throws on failure without leaking the api key or secret", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) =>
      (init.method ?? "GET") === "GET"
        ? jsonResponse({ data: [] })
        : jsonResponse({ error: "bad" }, 422),
    ) as unknown as typeof fetch

    const err = await registerKapsoWebhook({
      apiKey: "SUPER_SECRET_KEY",
      phoneNumberId: "PN1",
      url: URL,
      secret: "SUPER_SECRET_VAL",
      fetchImpl,
    }).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/422/)
    expect((err as Error).message).not.toContain("SUPER_SECRET_KEY")
    expect((err as Error).message).not.toContain("SUPER_SECRET_VAL")
  })
})
