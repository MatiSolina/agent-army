import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import type {
  OAuthClientInformation,
  OAuthAuthorizationServerInformation,
  OAuthTokens,
} from "@ai-sdk/mcp"
import { getFreshAccessToken } from "./get-fresh-token"
import type { OAuthRecord, OAuthStore } from "./oauth-store"

// The real guard does DNS resolution; stub it so the refresh path stays hermetic
// (its own behavior is covered by ssrf-guard.test.ts).
vi.mock("./ssrf-guard", () => ({ assertPublicHttpUrl: async (u: string) => new URL(u) }))
// loadIssuedAt() reads the DB; stub it to return no stamp (oauthTokensUpdatedAt null)
// so the "unknown issuance" path can be exercised without injecting issuedAt.
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ oauthTokensUpdatedAt: null }] }) }) }) },
}))
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }))

// In-memory OAuthStore (mirrors the one in oauth-provider.test.ts) so the helper
// can be exercised with no database and no network.
class InMemoryOAuthStore implements OAuthStore {
  records = new Map<string, OAuthRecord>()

  private blank(): OAuthRecord {
    return {
      oauthClientInfo: null,
      oauthServerInfo: null,
      oauthTokens: null,
      oauthCodeVerifier: null,
      oauthState: null,
      oauthScope: null,
    }
  }

  async load(connectionId: string): Promise<OAuthRecord | null> {
    return this.records.get(connectionId) ?? null
  }

  async patch(
    connectionId: string,
    fields: Partial<OAuthRecord>,
  ): Promise<void> {
    const current = this.records.get(connectionId) ?? this.blank()
    this.records.set(connectionId, { ...current, ...fields })
  }

  seed(connectionId: string, rec: Partial<OAuthRecord>): void {
    this.records.set(connectionId, { ...this.blank(), ...rec })
  }
}

const CID = "conn-1"

const SERVER: OAuthAuthorizationServerInformation = {
  authorizationServerUrl: "https://auth.example.com",
  tokenEndpoint: "https://auth.example.com/token",
}

const CLIENT: OAuthClientInformation = {
  client_id: "client-123",
}

function makeStore(tokens: OAuthTokens | null) {
  const store = new InMemoryOAuthStore()
  store.seed(CID, {
    oauthClientInfo: CLIENT,
    oauthServerInfo: SERVER,
    oauthTokens: tokens,
  })
  return store
}

describe("getFreshAccessToken", () => {
  describe("valid (unexpired) token", () => {
    it("returns the stored token without calling the token endpoint", async () => {
      const store = makeStore({
        access_token: "AT-current",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "RT-1",
      })
      const fetchFn = vi.fn()
      const now = () => 1_000_000
      // issued just now, expires in an hour → well outside the 60s margin.
      const issuedAt = 1_000_000

      const result = await getFreshAccessToken(CID, {
        store,
        now,
        fetchFn: fetchFn as unknown as typeof fetch,
        issuedAt,
      })

      expect(result.token).toBe("AT-current")
      expect(result.expiresAt).toBe(1_000_000 + 3600 * 1000)
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })

  describe("expired token with refresh_token", () => {
    it("refreshes against tokenEndpoint, persists, and returns the new token", async () => {
      const store = makeStore({
        access_token: "AT-stale",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "RT-old",
      })
      // issued long ago → expired relative to `now`.
      const issuedAt = 0
      const now = () => 10_000_000

      const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(SERVER.tokenEndpoint)
        expect(init.method).toBe("POST")
        const body = (init.body as URLSearchParams).toString()
        expect(body).toContain("grant_type=refresh_token")
        expect(body).toContain("refresh_token=RT-old")
        // public client → client_id in the body, no Basic auth header.
        expect(body).toContain("client_id=client-123")
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "NEW",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "NEW-RT",
          }),
        } as unknown as Response
      })

      const result = await getFreshAccessToken(CID, {
        store,
        now,
        fetchFn: fetchFn as unknown as typeof fetch,
        issuedAt,
      })

      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(result.token).toBe("NEW")
      expect(result.expiresAt).toBe(10_000_000 + 3600 * 1000)
      // persisted new tokens to the store
      const rec = await store.load(CID)
      expect(rec?.oauthTokens?.access_token).toBe("NEW")
      expect(rec?.oauthTokens?.refresh_token).toBe("NEW-RT")
    })

    it("preserves the old refresh_token when the AS does not rotate one", async () => {
      const store = makeStore({
        access_token: "AT-stale",
        token_type: "bearer",
        expires_in: 60,
        refresh_token: "RT-keep",
      })
      const fetchFn = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "NEW2",
          token_type: "bearer",
          expires_in: 3600,
        }),
      }) as unknown as Response)

      await getFreshAccessToken(CID, {
        store,
        now: () => 10_000_000,
        fetchFn: fetchFn as unknown as typeof fetch,
        issuedAt: 0,
      })

      const rec = await store.load(CID)
      expect(rec?.oauthTokens?.refresh_token).toBe("RT-keep")
    })

    it("refreshes when issuance time is UNKNOWN (no oauthTokensUpdatedAt stamp)", async () => {
      // No issuedAt injected → loadIssuedAt() returns undefined (db mock: null
      // stamp). A token with a declared lifetime + unknown age must NOT be
      // trusted: force a refresh rather than hand back a possibly-stale token.
      const store = makeStore({
        access_token: "AT-unknown-age",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "RT-x",
      })
      const fetchFn = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "FRESH", token_type: "bearer", expires_in: 3600 }),
      }) as unknown as Response)

      const res = await getFreshAccessToken(CID, {
        store,
        now: () => 10_000_000,
        fetchFn: fetchFn as unknown as typeof fetch,
      })

      expect(fetchFn).toHaveBeenCalledTimes(1) // refreshed, not trusted
      expect(res.token).toBe("FRESH")
    })
  })

  describe("no usable token", () => {
    it("throws when there is no access_token at all", async () => {
      const store = makeStore(null)
      await expect(
        getFreshAccessToken(CID, {
          store,
          now: () => 0,
          fetchFn: vi.fn() as unknown as typeof fetch,
          issuedAt: 0,
        }),
      ).rejects.toThrow()
    })

    it("throws when the token is expired and there is no refresh_token", async () => {
      const store = makeStore({
        access_token: "AT-stale",
        token_type: "bearer",
        expires_in: 60,
      })
      await expect(
        getFreshAccessToken(CID, {
          store,
          now: () => 10_000_000,
          fetchFn: vi.fn() as unknown as typeof fetch,
          issuedAt: 0,
        }),
      ).rejects.toThrow()
    })
  })

  describe("refresh failure", () => {
    it("throws when the token endpoint returns a non-ok response", async () => {
      const store = makeStore({
        access_token: "AT-stale",
        token_type: "bearer",
        expires_in: 60,
        refresh_token: "RT-old",
      })
      const fetchFn = vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({}),
      }) as unknown as Response)
      await expect(
        getFreshAccessToken(CID, {
          store,
          now: () => 10_000_000,
          fetchFn: fetchFn as unknown as typeof fetch,
          issuedAt: 0,
        }),
      ).rejects.toThrow()
    })
  })

  describe("token redaction", () => {
    let logSpy: ReturnType<typeof vi.spyOn>
    let errSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    })
    afterEach(() => {
      logSpy.mockRestore()
      errSpy.mockRestore()
    })

    it("never logs the access or refresh token across a refresh", async () => {
      const store = makeStore({
        access_token: "AT-secret-stale",
        token_type: "bearer",
        expires_in: 60,
        refresh_token: "RT-secret",
      })
      const fetchFn = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "NEW-secret",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "NEW-RT-secret",
        }),
      }) as unknown as Response)

      await getFreshAccessToken(CID, {
        store,
        now: () => 10_000_000,
        fetchFn: fetchFn as unknown as typeof fetch,
        issuedAt: 0,
      })

      const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
        .flat()
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")
      expect(logged).not.toContain("AT-secret-stale")
      expect(logged).not.toContain("RT-secret")
      expect(logged).not.toContain("NEW-secret")
      expect(logged).not.toContain("NEW-RT-secret")
    })
  })
})
