import { describe, it, expect, beforeEach } from "vitest"
import type {
  OAuthClientInformation,
  OAuthAuthorizationServerInformation,
  OAuthTokens,
} from "@ai-sdk/mcp"
import { DbOAuthClientProvider, APP_CLIENT_NAME } from "./oauth-provider"
import type { OAuthRecord, OAuthStore } from "./oauth-store"

// In-memory OAuthStore implementation so the provider can be exercised with no
// database and no network. One record per connection id.
class InMemoryOAuthStore implements OAuthStore {
  private records = new Map<string, OAuthRecord>()

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
}

const ORIGIN = "https://app.test"
const CID = "conn-1"

function makeProvider(scope: string | undefined = "read write") {
  const store = new InMemoryOAuthStore()
  const provider = new DbOAuthClientProvider(store, CID, ORIGIN, scope)
  return { store, provider }
}

describe("DbOAuthClientProvider", () => {
  describe("redirectUrl + clientMetadata", () => {
    it("uses a single fixed callback with the connection id as cid", () => {
      const { provider } = makeProvider()
      expect(provider.redirectUrl).toBe(
        `${ORIGIN}/api/mcp/callback?cid=${CID}`,
      )
    })

    it("exposes a public PKCE-only client metadata document", () => {
      const { provider } = makeProvider("read write")
      const meta = provider.clientMetadata
      expect(meta.client_name).toBe(APP_CLIENT_NAME)
      expect(meta.redirect_uris).toEqual([
        `${ORIGIN}/api/mcp/callback?cid=${CID}`,
      ])
      expect(meta.token_endpoint_auth_method).toBe("none")
      expect(meta.response_types).toEqual(["code"])
      expect(meta.grant_types).toEqual([
        "authorization_code",
        "refresh_token",
      ])
      expect(meta.scope).toBe("read write")
    })

    it("encodes the cid query parameter", () => {
      const store = new InMemoryOAuthStore()
      const provider = new DbOAuthClientProvider(
        store,
        "a b/c",
        ORIGIN,
        undefined,
      )
      expect(provider.redirectUrl).toBe(
        `${ORIGIN}/api/mcp/callback?cid=a%20b%2Fc`,
      )
    })
  })

  describe("tokens", () => {
    it("round-trips and overwrites (refresh-token rotation)", async () => {
      const { provider } = makeProvider()
      expect(await provider.tokens()).toBeUndefined()

      const first: OAuthTokens = {
        access_token: "at-1",
        token_type: "bearer",
        refresh_token: "rt-1",
      }
      await provider.saveTokens(first)
      expect(await provider.tokens()).toEqual(first)

      const second: OAuthTokens = {
        access_token: "at-2",
        token_type: "bearer",
        refresh_token: "rt-2",
      }
      await provider.saveTokens(second)
      // Wholesale overwrite — no merge of the old refresh token.
      expect(await provider.tokens()).toEqual(second)
    })
  })

  describe("clientInformation + authorizationServerInformation", () => {
    it("round-trips DCR client information", async () => {
      const { provider } = makeProvider()
      expect(await provider.clientInformation()).toBeUndefined()
      const info: OAuthClientInformation = {
        client_id: "client-123",
        client_secret: "secret-xyz",
      }
      await provider.saveClientInformation(info)
      expect(await provider.clientInformation()).toEqual(info)
    })

    it("round-trips authorization server information", async () => {
      const { provider } = makeProvider()
      expect(await provider.authorizationServerInformation()).toBeUndefined()
      const as: OAuthAuthorizationServerInformation = {
        authorizationServerUrl: "https://auth.example.com",
        tokenEndpoint: "https://auth.example.com/token",
      }
      await provider.saveAuthorizationServerInformation(as)
      expect(await provider.authorizationServerInformation()).toEqual(as)
    })
  })

  describe("CSRF state", () => {
    it("state() returns a non-empty string", async () => {
      const { provider } = makeProvider()
      const s = await provider.state()
      expect(typeof s).toBe("string")
      expect(s.length).toBeGreaterThan(0)
    })

    it("saveState then storedState round-trips, and mismatch is detectable", async () => {
      const { provider } = makeProvider()
      expect(await provider.storedState()).toBeUndefined()
      await provider.saveState("state-abc")
      expect(await provider.storedState()).toBe("state-abc")
      expect(await provider.storedState()).not.toBe("state-xyz")
    })

    it("state() is deterministic: returns the already-stored state instead of minting a new one", async () => {
      const { provider } = makeProvider()
      await provider.saveState("state-fixed")
      // A second call to state() must NOT mint a fresh UUID — it must echo the
      // stored value so CSRF protection cannot be silently broken by a future
      // SDK that calls state() again at callback time.
      expect(await provider.state()).toBe("state-fixed")
      expect(await provider.state()).toBe("state-fixed")
    })

    it("state() mints a fresh value only when none is stored yet", async () => {
      const { provider } = makeProvider()
      const minted = await provider.state()
      expect(typeof minted).toBe("string")
      expect(minted.length).toBeGreaterThan(0)
    })
  })

  describe("PKCE code verifier", () => {
    it("throws when no verifier has been saved", async () => {
      const { provider } = makeProvider()
      await expect(provider.codeVerifier()).rejects.toThrow()
    })

    it("round-trips after saveCodeVerifier", async () => {
      const { provider } = makeProvider()
      await provider.saveCodeVerifier("verifier-123")
      expect(await provider.codeVerifier()).toBe("verifier-123")
    })
  })

  describe("validateAuthorizationServerURL (SSRF guard)", () => {
    it("passes for https URLs", () => {
      const { provider } = makeProvider()
      expect(() =>
        provider.validateAuthorizationServerURL(
          "https://mcp.example.com",
          "https://auth.example.com",
        ),
      ).not.toThrow()
    })

    it("throws for http (non-TLS) authorization servers", () => {
      const { provider } = makeProvider()
      expect(() =>
        provider.validateAuthorizationServerURL(
          "https://mcp.example.com",
          "http://auth.example.com",
        ),
      ).toThrow()
    })

    it("throws for malformed authorization server URLs", () => {
      const { provider } = makeProvider()
      expect(() =>
        provider.validateAuthorizationServerURL(
          "https://mcp.example.com",
          "not a url",
        ),
      ).toThrow()
    })
  })

  describe("redirectToAuthorization", () => {
    it("captures the URL without navigating", () => {
      const { provider } = makeProvider()
      expect(provider.pendingAuthorizationUrl).toBeNull()
      const url = new URL("https://auth.example.com/authorize?x=1")
      expect(() => provider.redirectToAuthorization(url)).not.toThrow()
      expect(provider.pendingAuthorizationUrl).toEqual(url)
    })
  })
})
