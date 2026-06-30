import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  ACCESS_TOKEN_TTL_SECONDS,
  FLEET_MCP_RESOURCE_PATH,
  FLEET_MCP_SCOPES,
  FleetMcpOAuthService,
  InMemoryFleetMcpOAuthStore,
  createAuthorizationServerMetadata,
  createProtectedResourceMetadata,
  hashToken,
  verifyS256Pkce,
} from "./oauth"

const ISSUER = "https://fm.test"
const RESOURCE = `${ISSUER}${FLEET_MCP_RESOURCE_PATH}`

function s256(verifier: string) {
  return createHash("sha256")
    .update(verifier)
    .digest("base64url")
}

async function registeredService() {
  const store = new InMemoryFleetMcpOAuthStore()
  const oauth = new FleetMcpOAuthService(store, {
    issuer: ISSUER,
    resource: RESOURCE,
    now: () => new Date("2026-06-29T12:00:00.000Z"),
  })
  const client = await oauth.registerClient({
    client_name: "Claude Desktop",
    redirect_uris: ["https://claude.ai/api/mcp/auth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "fleet:read deploy:write",
  })
  return { store, oauth, client }
}

describe("Fleet MCP OAuth metadata", () => {
  it("publishes resource metadata with authorization server and supported scopes", () => {
    expect(createProtectedResourceMetadata(ISSUER)).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: FLEET_MCP_SCOPES,
    })
  })

  it("publishes an OAuth 2.1 authorization server with DCR + PKCE-only auth code", () => {
    expect(createAuthorizationServerMetadata(ISSUER)).toMatchObject({
      issuer: ISSUER,
      registration_endpoint: `${ISSUER}/api/fleet-mcp/oauth/register`,
      authorization_endpoint: `${ISSUER}/api/fleet-mcp/oauth/authorize`,
      token_endpoint: `${ISSUER}/api/fleet-mcp/oauth/token`,
      revocation_endpoint: `${ISSUER}/api/fleet-mcp/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    })
  })
})

describe("Fleet MCP OAuth 2.1 flow", () => {
  it("validates PKCE S256 challenges", () => {
    const verifier = "correct horse battery staple"
    expect(verifyS256Pkce(verifier, s256(verifier))).toBe(true)
    expect(verifyS256Pkce("wrong", s256(verifier))).toBe(false)
  })

  it("rejects DCR redirect URIs that cannot be used safely by a public PKCE client", async () => {
    const { oauth } = await registeredService()

    await expect(
      oauth.registerClient({
        redirect_uris: ["http://evil.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    ).rejects.toThrow(/redirect_uri/i)
  })

  it("enforces exact redirect URI matching and the Fleet MCP resource parameter", async () => {
    const { oauth, client } = await registeredService()

    await expect(
      oauth.startAuthorization({
        clientId: client.client_id,
        redirectUri: "https://claude.ai/other",
        responseType: "code",
        scope: "fleet:read",
        state: "s",
        resource: RESOURCE,
        codeChallenge: s256("verifier"),
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow(/redirect_uri/i)

    await expect(
      oauth.startAuthorization({
        clientId: client.client_id,
        redirectUri: "https://claude.ai/api/mcp/auth/callback",
        responseType: "code",
        scope: "fleet:read",
        state: "s",
        resource: "https://fm.test/mcp",
        codeChallenge: s256("verifier"),
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow(/resource/i)
  })

  it("requires operator approval before an authorization code can be exchanged", async () => {
    const { oauth, client } = await registeredService()
    const request = await oauth.startAuthorization({
      clientId: client.client_id,
      redirectUri: "https://claude.ai/api/mcp/auth/callback",
      responseType: "code",
      scope: "fleet:read",
      state: "s",
      resource: RESOURCE,
      codeChallenge: s256("verifier"),
      codeChallengeMethod: "S256",
    })

    await expect(
      oauth.exchangeAuthorizationCode({
        code: request.id,
        codeVerifier: "verifier",
        clientId: client.client_id,
        redirectUri: "https://claude.ai/api/mcp/auth/callback",
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/authorization code/i)
  })

  it("issues hash-only tokens, rotates refresh tokens, and enforces revocation", async () => {
    const { oauth, client, store } = await registeredService()
    const auth = await oauth.startAuthorization({
      clientId: client.client_id,
      redirectUri: "https://claude.ai/api/mcp/auth/callback",
      responseType: "code",
      scope: "fleet:read deploy:write",
      state: "abc",
      resource: RESOURCE,
      codeChallenge: s256("verifier"),
      codeChallengeMethod: "S256",
    })
    const approved = await oauth.approveAuthorizationRequest(auth.id, {
      userId: "demo-user",
    })

    const tokens = await oauth.exchangeAuthorizationCode({
      code: approved.code,
      codeVerifier: "verifier",
      clientId: client.client_id,
      redirectUri: "https://claude.ai/api/mcp/auth/callback",
      resource: RESOURCE,
    })

    expect(tokens.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS)
    expect(store.snapshotTokens()).not.toContain(tokens.access_token)
    expect(store.snapshotTokens()).not.toContain(tokens.refresh_token)
    expect(await oauth.verifyAccessToken(tokens.access_token, RESOURCE)).toMatchObject({
      clientId: client.client_id,
      scopes: ["fleet:read", "deploy:write"],
      resource: RESOURCE,
    })

    const rotated = await oauth.refreshAccessToken({
      refreshToken: tokens.refresh_token,
      clientId: client.client_id,
      resource: RESOURCE,
    })
    await expect(
      oauth.refreshAccessToken({
        refreshToken: tokens.refresh_token,
        clientId: client.client_id,
        resource: RESOURCE,
      }),
    ).rejects.toThrow(/refresh token/i)

    await oauth.revokeToken(rotated.access_token)
    await expect(
      oauth.verifyAccessToken(rotated.access_token, RESOURCE),
    ).rejects.toThrow(/access token/i)
  })

  it("rejects re-using a consumed authorization code (no double token issue)", async () => {
    const { oauth, client } = await registeredService()
    const auth = await oauth.startAuthorization({
      clientId: client.client_id,
      redirectUri: "https://claude.ai/api/mcp/auth/callback",
      responseType: "code",
      scope: "fleet:read",
      state: "x",
      resource: RESOURCE,
      codeChallenge: s256("verifier"),
      codeChallengeMethod: "S256",
    })
    const approved = await oauth.approveAuthorizationRequest(auth.id, { userId: "demo-user" })
    const exchange = () =>
      oauth.exchangeAuthorizationCode({
        code: approved.code,
        codeVerifier: "verifier",
        clientId: client.client_id,
        redirectUri: "https://claude.ai/api/mcp/auth/callback",
        resource: RESOURCE,
      })
    await expect(exchange()).resolves.toMatchObject({ token_type: "Bearer" })
    await expect(exchange()).rejects.toThrow(/already used/i)
  })

  it("uses deterministic token hashes for persistence lookups", () => {
    expect(hashToken("fmcp_at_secret")).toBe(hashToken("fmcp_at_secret"))
    expect(hashToken("fmcp_at_secret")).not.toContain("fmcp_at_secret")
  })
})
