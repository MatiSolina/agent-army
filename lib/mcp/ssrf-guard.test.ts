import { describe, it, expect, vi } from "vitest"

// Control DNS so the async check is hermetic: map a couple of hostnames to
// chosen addresses, everything else "resolves" to a public IP.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "internal.example.com") return [{ address: "10.1.2.3", family: 4 }]
    if (host === "public.example.com") return [{ address: "93.184.216.34", family: 4 }]
    if (host === "nores.example.com") return []
    return [{ address: "93.184.216.34", family: 4 }]
  },
}))

import { assertPublicHttpUrl, assertPublicHttpUrlSync } from "./ssrf-guard"

describe("assertPublicHttpUrlSync (structural)", () => {
  it("accepts a public https host", () => {
    expect(() => assertPublicHttpUrlSync("https://api.notion.com/v1")).not.toThrow()
  })

  for (const bad of [
    "http://api.notion.com", // non-https
    "https://localhost/x",
    "https://foo.local/x",
    "https://service.internal/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://169.254.169.254/latest", // cloud metadata
    "https://192.168.1.1/x",
    "https://[::1]/x",
    "https://[fd00::1]/x",
  ]) {
    it(`rejects ${bad}`, () => {
      expect(() => assertPublicHttpUrlSync(bad)).toThrow()
    })
  }
})

describe("assertPublicHttpUrl (DNS-resolving)", () => {
  it("accepts a hostname resolving to a public IP", async () => {
    await expect(assertPublicHttpUrl("https://public.example.com/x")).resolves.toBeInstanceOf(URL)
  })

  it("rejects a hostname resolving to a private IP (DNS-rebinding)", async () => {
    await expect(assertPublicHttpUrl("https://internal.example.com/x")).rejects.toThrow(/private/)
  })

  it("rejects a hostname that does not resolve", async () => {
    await expect(assertPublicHttpUrl("https://nores.example.com/x")).rejects.toThrow(/resolve/)
  })

  it("rejects a literal private IP without a DNS lookup", async () => {
    await expect(assertPublicHttpUrl("https://10.0.0.1/x")).rejects.toThrow(/private/)
  })
})
