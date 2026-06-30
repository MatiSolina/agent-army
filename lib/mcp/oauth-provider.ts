import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthAuthorizationServerInformation,
  OAuthTokens,
} from "@ai-sdk/mcp"
import type { OAuthStore } from "./oauth-store"
import { assertPublicHttpUrlSync } from "./ssrf-guard"

/** The client_name advertised during Dynamic Client Registration. */
export const APP_CLIENT_NAME = "Agent Army"

/**
 * A DB-backed (via an injected `OAuthStore`) implementation of the AI SDK's
 * `OAuthClientProvider`. It is intentionally pure: all persistence goes
 * through the store, and signed-in workspace scoping lives in the store.
 *
 * Server-side only. The provider never navigates the browser: when the SDK
 * wants a redirect, `redirectToAuthorization` stashes the URL so the calling
 * route handler can issue the HTTP 302 itself.
 */
export class DbOAuthClientProvider implements OAuthClientProvider {
  /**
   * Captured by `redirectToAuthorization`. The connect route reads this to
   * issue the 302 to the authorization endpoint.
   */
  public pendingAuthorizationUrl: URL | null = null

  constructor(
    private readonly store: OAuthStore,
    private readonly connectionId: string,
    /** Request origin, e.g. "https://app.example.com". */
    private readonly origin: string,
    /** Requested scope string from the catalog entry (may be undefined). */
    private readonly requestedScope: string | undefined,
  ) {}

  /**
   * The exact redirect_uri used at authorize, token-exchange, and DCR. A
   * single fixed callback route carries the connection id as the `cid` query
   * param. This value must be byte-identical across all three legs.
   */
  get redirectUrl(): string {
    return `${this.origin}/api/mcp/callback?cid=${encodeURIComponent(
      this.connectionId,
    )}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: APP_CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client; PKCE-only (no client secret stored or sent).
      token_endpoint_auth_method: "none",
      scope: this.requestedScope,
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return (await this.store.load(this.connectionId))?.oauthClientInfo ?? undefined
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    await this.store.patch(this.connectionId, { oauthClientInfo: info })
  }

  async authorizationServerInformation(): Promise<
    OAuthAuthorizationServerInformation | undefined
  > {
    return (
      (await this.store.load(this.connectionId))?.oauthServerInfo ?? undefined
    )
  }

  async saveAuthorizationServerInformation(
    info: OAuthAuthorizationServerInformation,
  ): Promise<void> {
    await this.store.patch(this.connectionId, { oauthServerInfo: info })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load(this.connectionId))?.oauthTokens ?? undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Refresh-token rotation: overwrite wholesale with whatever the AS returned.
    await this.store.patch(this.connectionId, { oauthTokens: tokens })
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.patch(this.connectionId, { oauthCodeVerifier: verifier })
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.store.load(this.connectionId))?.oauthCodeVerifier
    if (!v) {
      throw new Error(
        `Missing PKCE code_verifier for connection ${this.connectionId}`,
      )
    }
    return v
  }

  async state(): Promise<string> {
    // CSRF state value. PKCE S256 itself is handled by the SDK.
    // Deterministic per-connection: if a state is already stored for this
    // in-flight authorization, echo it instead of minting a fresh UUID. Only
    // mint a new value when none exists yet. This keeps CSRF protection from
    // silently breaking if the SDK ever calls state() more than once (e.g. at
    // callback time) rather than storedState().
    const existing = (await this.store.load(this.connectionId))?.oauthState
    if (existing) return existing
    return crypto.randomUUID()
  }

  async saveState(state: string): Promise<void> {
    await this.store.patch(this.connectionId, { oauthState: state })
  }

  async storedState(): Promise<string | undefined> {
    return (await this.store.load(this.connectionId))?.oauthState ?? undefined
  }

  /**
   * SSRF guard: reject discovered authorization servers that are not public
   * https hosts (blocks loopback/private/link-local literals and obvious
   * internal hostnames). Sync hook → structural check only; the operator-
   * supplied server URL gets the full DNS-resolving check at connect time.
   */
  validateAuthorizationServerURL(
    _serverUrl: string | URL,
    authorizationServerUrl: string | URL,
  ): void {
    assertPublicHttpUrlSync(authorizationServerUrl)
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Do NOT navigate here. Capture so the connect route can issue the 302.
    this.pendingAuthorizationUrl = authorizationUrl
  }
}
