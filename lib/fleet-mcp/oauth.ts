import {
  createHash,
  randomBytes,
  timingSafeEqual,
  randomUUID,
} from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/lib/db"
import {
  fleetMcpOAuthAuthorizationCodes,
  fleetMcpOAuthAuthorizationRequests,
  fleetMcpOAuthClients,
  fleetMcpOAuthConsents,
  fleetMcpOAuthTokens,
  type FleetMcpOAuthAuthorizationCode,
  type FleetMcpOAuthAuthorizationRequest,
  type FleetMcpOAuthClient,
  type FleetMcpOAuthToken,
} from "@/lib/db/schema"
import { DEMO_USER_ID } from "@/lib/session"
import { isFleetMcpE2eMode } from "@/lib/fleet-mcp/e2e"

export const FLEET_MCP_RESOURCE_PATH = "/api/fleet-mcp"
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60

export const FLEET_MCP_SCOPES = [
  "fleet:read",
  "agent:write",
  "deploy:read",
  "deploy:write",
  "fleet:update",
] as const

type FleetMcpScope = (typeof FLEET_MCP_SCOPES)[number]

type OAuthClientRecord = {
  id: string
  userId: string
  clientName: string | null
  redirectUris: string[]
  grantTypes: string[]
  responseTypes: string[]
  tokenEndpointAuthMethod: string
  scopes: string[]
  createdAt: Date
  updatedAt: Date
}

type AuthorizationRequestRecord = {
  id: string
  userId: string | null
  clientId: string
  redirectUri: string
  scopes: string[]
  state: string | null
  resource: string
  codeChallenge: string
  codeChallengeMethod: string
  expiresAt: Date
  approvedAt: Date | null
  deniedAt: Date | null
  consumedAt: Date | null
  createdAt: Date
}

type AuthorizationCodeRecord = {
  codeHash: string
  requestId: string
  userId: string
  clientId: string
  redirectUri: string
  scopes: string[]
  resource: string
  codeChallenge: string
  codeChallengeMethod: string
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

type TokenRecord = {
  tokenHash: string
  kind: "access" | "refresh"
  userId: string
  clientId: string
  scopes: string[]
  resource: string
  expiresAt: Date
  revokedAt: Date | null
  rotatedToHash: string | null
  createdAt: Date
}

export type RegisteredFleetMcpClient = {
  client_id: string
  client_id_issued_at: number
  client_name?: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: "none"
  scope: string
}

export type FleetMcpTokenResponse = {
  access_token: string
  refresh_token: string
  token_type: "Bearer"
  expires_in: number
  scope: string
}

export type VerifiedFleetMcpToken = {
  token: string
  clientId: string
  scopes: string[]
  expiresAt: number
  resource: string
  extra: { userId: string }
}

export interface FleetMcpOAuthStore {
  saveClient(client: OAuthClientRecord): Promise<void>
  getClient(clientId: string): Promise<OAuthClientRecord | null>
  saveAuthorizationRequest(request: AuthorizationRequestRecord): Promise<void>
  getAuthorizationRequest(
    requestId: string,
  ): Promise<AuthorizationRequestRecord | null>
  updateAuthorizationRequest(
    requestId: string,
    patch: Partial<AuthorizationRequestRecord>,
  ): Promise<void>
  saveAuthorizationCode(code: AuthorizationCodeRecord): Promise<void>
  getAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null>
  updateAuthorizationCode(
    codeHash: string,
    patch: Partial<AuthorizationCodeRecord>,
  ): Promise<void>
  /** Atomically mark an auth code consumed; true iff THIS call won the race. */
  consumeAuthorizationCode(codeHash: string, now: Date): Promise<boolean>
  saveToken(token: TokenRecord): Promise<void>
  getToken(tokenHash: string): Promise<TokenRecord | null>
  updateToken(tokenHash: string, patch: Partial<TokenRecord>): Promise<void>
  /** Atomically revoke a still-active refresh token; true iff THIS call won. */
  revokeRefreshTokenIfActive(tokenHash: string, now: Date): Promise<boolean>
  saveConsent(input: {
    userId: string
    clientId: string
    redirectUri: string
    resource: string
    scopes: string[]
  }): Promise<void>
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "")
}

export function issuerFromRequest(req: Request): string {
  const configured =
    process.env.FLEET_MCP_ISSUER ??
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined)
  return normalizeBaseUrl(configured ?? new URL(req.url).origin)
}

export function resourceFromIssuer(issuer: string): string {
  return `${normalizeBaseUrl(issuer)}${FLEET_MCP_RESOURCE_PATH}`
}

export function createProtectedResourceMetadata(issuer: string) {
  return {
    resource: resourceFromIssuer(issuer),
    authorization_servers: [normalizeBaseUrl(issuer)],
    bearer_methods_supported: ["header"],
    scopes_supported: FLEET_MCP_SCOPES,
  }
}

export function createAuthorizationServerMetadata(issuer: string) {
  const base = normalizeBaseUrl(issuer)
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/fleet-mcp/oauth/authorize`,
    token_endpoint: `${base}/api/fleet-mcp/oauth/token`,
    registration_endpoint: `${base}/api/fleet-mcp/oauth/register`,
    revocation_endpoint: `${base}/api/fleet-mcp/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: FLEET_MCP_SCOPES,
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function verifyS256Pkce(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  const actual = createHash("sha256").update(codeVerifier).digest("base64url")
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(codeChallenge)
  if (actualBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000)
}

function epochSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000)
}

function token(prefix: string) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`
}

function parseScopes(scope: string | undefined | null): string[] {
  return (scope ?? "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function assertScopesSupported(scopes: string[]) {
  const supported = new Set<string>(FLEET_MCP_SCOPES)
  for (const scope of scopes) {
    if (!supported.has(scope)) {
      throw new Error(`Unsupported scope: ${scope}`)
    }
  }
}

function assertScopeSubset(scopes: string[], allowed: string[]) {
  const allowedSet = new Set(allowed)
  for (const scope of scopes) {
    if (!allowedSet.has(scope)) {
      throw new Error(`Client is not allowed to request scope: ${scope}`)
    }
  }
}

function validatePublicRedirectUri(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("redirect_uri must be a valid URL")
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1"
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback)) {
    return
  }
  throw new Error("redirect_uri must use HTTPS or loopback HTTP")
}

function assertExactResource(actual: string, expected: string) {
  if (normalizeBaseUrl(actual) !== normalizeBaseUrl(expected)) {
    throw new Error("Invalid resource parameter")
  }
}

function assertNotExpired(expiresAt: Date, now: Date, label: string) {
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error(`${label} expired`)
  }
}

function toRegisteredClient(client: OAuthClientRecord): RegisteredFleetMcpClient {
  return {
    client_id: client.id,
    client_id_issued_at: epochSeconds(client.createdAt),
    ...(client.clientName ? { client_name: client.clientName } : {}),
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: "none",
    scope: client.scopes.join(" "),
  }
}

export class FleetMcpOAuthService {
  constructor(
    private readonly store: FleetMcpOAuthStore,
    private readonly options: {
      issuer: string
      resource: string
      now?: () => Date
    },
  ) {}

  private now() {
    return this.options.now?.() ?? new Date()
  }

  async registerClient(input: {
    client_name?: unknown
    redirect_uris?: unknown
    grant_types?: unknown
    response_types?: unknown
    token_endpoint_auth_method?: unknown
    scope?: unknown
  }): Promise<RegisteredFleetMcpClient> {
    const redirectUris = Array.isArray(input.redirect_uris)
      ? input.redirect_uris.filter((uri): uri is string => typeof uri === "string")
      : []
    if (redirectUris.length === 0) {
      throw new Error("redirect_uris is required")
    }
    // Bound persisted metadata: this is public DCR, so cap count + length so a
    // single registration can't store unbounded data.
    if (redirectUris.length > 10) {
      throw new Error("Too many redirect_uris")
    }
    if (redirectUris.some((uri) => uri.length > 2048)) {
      throw new Error("redirect_uri is too long")
    }
    redirectUris.forEach(validatePublicRedirectUri)

    const grantTypes = Array.isArray(input.grant_types)
      ? input.grant_types.filter((grant): grant is string => typeof grant === "string")
      : ["authorization_code", "refresh_token"]
    if (
      grantTypes.some(
        (grant) => grant !== "authorization_code" && grant !== "refresh_token",
      )
    ) {
      throw new Error("Unsupported grant_type")
    }

    const responseTypes = Array.isArray(input.response_types)
      ? input.response_types.filter(
          (response): response is string => typeof response === "string",
        )
      : ["code"]
    if (responseTypes.some((responseType) => responseType !== "code")) {
      throw new Error("Unsupported response_type")
    }

    if (
      input.token_endpoint_auth_method != null &&
      input.token_endpoint_auth_method !== "none"
    ) {
      throw new Error("Only public PKCE clients are supported")
    }

    const requestedScopes = parseScopes(
      typeof input.scope === "string" ? input.scope : null,
    )
    assertScopesSupported(requestedScopes)
    const scopes = requestedScopes.length
      ? requestedScopes
      : [...FLEET_MCP_SCOPES]

    const now = this.now()
    const client: OAuthClientRecord = {
      id: `fmcp_client_${randomBytes(16).toString("base64url")}`,
      userId: DEMO_USER_ID,
      clientName:
        typeof input.client_name === "string"
          ? input.client_name.trim().slice(0, 120) || null
          : null,
      redirectUris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: "none",
      scopes,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.saveClient(client)
    return toRegisteredClient(client)
  }

  async startAuthorization(input: {
    clientId: string
    redirectUri: string
    responseType: string
    scope?: string
    state?: string | null
    resource: string
    codeChallenge: string
    codeChallengeMethod: string
  }): Promise<AuthorizationRequestRecord> {
    const client = await this.store.getClient(input.clientId)
    if (!client) throw new Error("Unknown client_id")
    if (input.responseType !== "code") throw new Error("Unsupported response_type")
    if (!client.redirectUris.includes(input.redirectUri)) {
      throw new Error("redirect_uri must exactly match a registered URI")
    }
    assertExactResource(input.resource, this.options.resource)
    if (input.codeChallengeMethod !== "S256") {
      throw new Error("PKCE code_challenge_method must be S256")
    }
    if (!input.codeChallenge) throw new Error("PKCE code_challenge is required")

    const scopes = parseScopes(input.scope)
    assertScopesSupported(scopes)
    assertScopeSubset(scopes, client.scopes)

    const now = this.now()
    const request: AuthorizationRequestRecord = {
      id: `fmcp_req_${randomBytes(16).toString("base64url")}`,
      userId: null,
      clientId: client.id,
      redirectUri: input.redirectUri,
      scopes,
      state: input.state ?? null,
      resource: this.options.resource,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      expiresAt: addSeconds(now, AUTHORIZATION_REQUEST_TTL_SECONDS),
      approvedAt: null,
      deniedAt: null,
      consumedAt: null,
      createdAt: now,
    }
    await this.store.saveAuthorizationRequest(request)
    return request
  }

  async getAuthorizationRequest(requestId: string) {
    return this.store.getAuthorizationRequest(requestId)
  }

  async approveAuthorizationRequest(
    requestId: string,
    input: { userId: string },
  ): Promise<{ code: string; redirectUri: string; state: string | null; location: string }> {
    const request = await this.store.getAuthorizationRequest(requestId)
    if (!request) throw new Error("Authorization request not found")
    const now = this.now()
    assertNotExpired(request.expiresAt, now, "Authorization request")
    if (request.deniedAt) throw new Error("Authorization request was denied")
    if (request.consumedAt) throw new Error("Authorization request already used")

    const code = token("fmcp_code")
    const codeRecord: AuthorizationCodeRecord = {
      codeHash: hashToken(code),
      requestId: request.id,
      userId: input.userId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      resource: request.resource,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      expiresAt: addSeconds(now, AUTHORIZATION_CODE_TTL_SECONDS),
      consumedAt: null,
      createdAt: now,
    }
    await this.store.saveAuthorizationCode(codeRecord)
    await this.store.updateAuthorizationRequest(request.id, {
      userId: input.userId,
      approvedAt: now,
    })
    await this.store.saveConsent({
      userId: input.userId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scopes: request.scopes,
    })

    const location = new URL(request.redirectUri)
    location.searchParams.set("code", code)
    if (request.state) location.searchParams.set("state", request.state)

    return {
      code,
      redirectUri: request.redirectUri,
      state: request.state,
      location: location.toString(),
    }
  }

  async denyAuthorizationRequest(requestId: string) {
    const request = await this.store.getAuthorizationRequest(requestId)
    if (!request) throw new Error("Authorization request not found")
    await this.store.updateAuthorizationRequest(requestId, {
      deniedAt: this.now(),
    })
    const location = new URL(request.redirectUri)
    location.searchParams.set("error", "access_denied")
    if (request.state) location.searchParams.set("state", request.state)
    return location.toString()
  }

  async exchangeAuthorizationCode(input: {
    code: string
    codeVerifier: string
    clientId: string
    redirectUri: string
    resource: string
  }): Promise<FleetMcpTokenResponse> {
    assertExactResource(input.resource, this.options.resource)
    const record = await this.store.getAuthorizationCode(hashToken(input.code))
    const now = this.now()
    if (!record) throw new Error("Invalid authorization code")
    assertNotExpired(record.expiresAt, now, "Authorization code")
    if (record.consumedAt) throw new Error("Authorization code already used")
    if (record.clientId !== input.clientId) {
      throw new Error("Invalid authorization code client")
    }
    if (record.redirectUri !== input.redirectUri) {
      throw new Error("Invalid authorization code redirect_uri")
    }
    if (!verifyS256Pkce(input.codeVerifier, record.codeChallenge)) {
      throw new Error("Invalid PKCE code_verifier")
    }

    // Atomically claim the code BEFORE issuing tokens: if two requests race,
    // only the one that flips consumedAt wins; the loser never gets a token pair.
    const won = await this.store.consumeAuthorizationCode(record.codeHash, now)
    if (!won) throw new Error("Authorization code already used")
    await this.store.updateAuthorizationRequest(record.requestId, {
      consumedAt: now,
    })
    return this.issueTokenPair(record.userId, record.clientId, record.scopes, now)
  }

  async refreshAccessToken(input: {
    refreshToken: string
    clientId: string
    resource: string
  }): Promise<FleetMcpTokenResponse> {
    assertExactResource(input.resource, this.options.resource)
    const now = this.now()
    const oldHash = hashToken(input.refreshToken)
    const record = await this.store.getToken(oldHash)
    if (!record || record.kind !== "refresh") throw new Error("Invalid refresh token")
    assertNotExpired(record.expiresAt, now, "Refresh token")
    if (record.revokedAt) throw new Error("Invalid refresh token")
    if (record.clientId !== input.clientId) throw new Error("Invalid refresh token client")
    assertExactResource(record.resource, this.options.resource)

    // Atomically claim the old refresh token BEFORE minting a new pair: only one
    // concurrent refresh wins, so a stolen/replayed refresh token can't yield two
    // valid pairs.
    const won = await this.store.revokeRefreshTokenIfActive(oldHash, now)
    if (!won) throw new Error("Invalid refresh token")
    const pair = await this.issueTokenPair(
      record.userId,
      record.clientId,
      record.scopes,
      now,
    )
    // Audit link old → new (best-effort; revocation above already enforced).
    await this.store.updateToken(oldHash, {
      rotatedToHash: hashToken(pair.refresh_token),
    })
    return pair
  }

  async verifyAccessToken(
    accessToken: string,
    resource: string,
  ): Promise<VerifiedFleetMcpToken> {
    assertExactResource(resource, this.options.resource)
    const now = this.now()
    const record = await this.store.getToken(hashToken(accessToken))
    if (!record || record.kind !== "access") throw new Error("Invalid access token")
    assertNotExpired(record.expiresAt, now, "Access token")
    if (record.revokedAt) throw new Error("Invalid access token")
    assertExactResource(record.resource, this.options.resource)
    return {
      token: accessToken,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: epochSeconds(record.expiresAt),
      resource: record.resource,
      extra: { userId: record.userId },
    }
  }

  async revokeToken(tokenValue: string): Promise<void> {
    await this.store.updateToken(hashToken(tokenValue), { revokedAt: this.now() })
  }

  private async issueTokenPair(
    userId: string,
    clientId: string,
    scopes: string[],
    now: Date,
  ): Promise<FleetMcpTokenResponse> {
    const accessToken = token("fmcp_at")
    const refreshToken = token("fmcp_rt")
    await this.store.saveToken({
      tokenHash: hashToken(accessToken),
      kind: "access",
      userId,
      clientId,
      scopes,
      resource: this.options.resource,
      expiresAt: addSeconds(now, ACCESS_TOKEN_TTL_SECONDS),
      revokedAt: null,
      rotatedToHash: null,
      createdAt: now,
    })
    await this.store.saveToken({
      tokenHash: hashToken(refreshToken),
      kind: "refresh",
      userId,
      clientId,
      scopes,
      resource: this.options.resource,
      expiresAt: addSeconds(now, REFRESH_TOKEN_TTL_SECONDS),
      revokedAt: null,
      rotatedToHash: null,
      createdAt: now,
    })
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(" "),
    }
  }
}

export class InMemoryFleetMcpOAuthStore implements FleetMcpOAuthStore {
  private readonly clients = new Map<string, OAuthClientRecord>()
  private readonly authorizationRequests = new Map<string, AuthorizationRequestRecord>()
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>()
  private readonly tokens = new Map<string, TokenRecord>()
  private readonly consents = new Map<string, unknown>()

  snapshotTokens() {
    return JSON.stringify([...this.tokens.values()])
  }

  async saveClient(client: OAuthClientRecord) {
    this.clients.set(client.id, { ...client })
  }

  async getClient(clientId: string) {
    return this.clients.get(clientId) ?? null
  }

  async saveAuthorizationRequest(request: AuthorizationRequestRecord) {
    this.authorizationRequests.set(request.id, { ...request })
  }

  async getAuthorizationRequest(requestId: string) {
    return this.authorizationRequests.get(requestId) ?? null
  }

  async updateAuthorizationRequest(
    requestId: string,
    patch: Partial<AuthorizationRequestRecord>,
  ) {
    const current = this.authorizationRequests.get(requestId)
    if (current) this.authorizationRequests.set(requestId, { ...current, ...patch })
  }

  async saveAuthorizationCode(code: AuthorizationCodeRecord) {
    this.authorizationCodes.set(code.codeHash, { ...code })
  }

  async getAuthorizationCode(codeHash: string) {
    return this.authorizationCodes.get(codeHash) ?? null
  }

  async updateAuthorizationCode(
    codeHash: string,
    patch: Partial<AuthorizationCodeRecord>,
  ) {
    const current = this.authorizationCodes.get(codeHash)
    if (current) this.authorizationCodes.set(codeHash, { ...current, ...patch })
  }

  // Read+write with no await between them → atomic on the single-threaded loop.
  async consumeAuthorizationCode(codeHash: string, now: Date) {
    const current = this.authorizationCodes.get(codeHash)
    if (!current || current.consumedAt) return false
    this.authorizationCodes.set(codeHash, { ...current, consumedAt: now })
    return true
  }

  async saveToken(tokenRecord: TokenRecord) {
    this.tokens.set(tokenRecord.tokenHash, { ...tokenRecord })
  }

  async getToken(tokenHash: string) {
    return this.tokens.get(tokenHash) ?? null
  }

  async updateToken(tokenHash: string, patch: Partial<TokenRecord>) {
    const current = this.tokens.get(tokenHash)
    if (current) this.tokens.set(tokenHash, { ...current, ...patch })
  }

  async revokeRefreshTokenIfActive(tokenHash: string, now: Date) {
    const current = this.tokens.get(tokenHash)
    if (!current || current.revokedAt) return false
    this.tokens.set(tokenHash, { ...current, revokedAt: now })
    return true
  }

  async saveConsent(input: {
    userId: string
    clientId: string
    redirectUri: string
    resource: string
    scopes: string[]
  }) {
    this.consents.set(
      `${input.userId}:${input.clientId}:${input.resource}:${input.redirectUri}`,
      input,
    )
  }
}

function e2eOAuthStore(): InMemoryFleetMcpOAuthStore {
  const globalStore = globalThis as typeof globalThis & {
    __fleetMcpE2eOAuthStore?: InMemoryFleetMcpOAuthStore
  }
  globalStore.__fleetMcpE2eOAuthStore ??= new InMemoryFleetMcpOAuthStore()
  return globalStore.__fleetMcpE2eOAuthStore
}

function clientFromDb(row: FleetMcpOAuthClient): OAuthClientRecord {
  return {
    id: row.id,
    userId: row.userId,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    grantTypes: row.grantTypes,
    responseTypes: row.responseTypes,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    scopes: row.scopes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function requestFromDb(
  row: FleetMcpOAuthAuthorizationRequest,
): AuthorizationRequestRecord {
  return {
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    scopes: row.scopes,
    state: row.state,
    resource: row.resource,
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    expiresAt: row.expiresAt,
    approvedAt: row.approvedAt,
    deniedAt: row.deniedAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  }
}

function codeFromDb(row: FleetMcpOAuthAuthorizationCode): AuthorizationCodeRecord {
  return {
    codeHash: row.codeHash,
    requestId: row.requestId,
    userId: row.userId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    scopes: row.scopes,
    resource: row.resource,
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  }
}

function tokenFromDb(row: FleetMcpOAuthToken): TokenRecord {
  if (row.kind !== "access" && row.kind !== "refresh") {
    throw new Error("Invalid token kind")
  }
  return {
    tokenHash: row.tokenHash,
    kind: row.kind,
    userId: row.userId,
    clientId: row.clientId,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    rotatedToHash: row.rotatedToHash,
    createdAt: row.createdAt,
  }
}

export class DbFleetMcpOAuthStore implements FleetMcpOAuthStore {
  async saveClient(client: OAuthClientRecord) {
    await db.insert(fleetMcpOAuthClients).values({
      id: client.id,
      userId: client.userId,
      clientName: client.clientName,
      redirectUris: client.redirectUris,
      grantTypes: client.grantTypes,
      responseTypes: client.responseTypes,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
      scopes: client.scopes,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    })
  }

  async getClient(clientId: string) {
    const rows = await db
      .select()
      .from(fleetMcpOAuthClients)
      .where(eq(fleetMcpOAuthClients.id, clientId))
    return rows[0] ? clientFromDb(rows[0]) : null
  }

  async saveAuthorizationRequest(request: AuthorizationRequestRecord) {
    await db.insert(fleetMcpOAuthAuthorizationRequests).values(request)
  }

  async getAuthorizationRequest(requestId: string) {
    const rows = await db
      .select()
      .from(fleetMcpOAuthAuthorizationRequests)
      .where(eq(fleetMcpOAuthAuthorizationRequests.id, requestId))
    return rows[0] ? requestFromDb(rows[0]) : null
  }

  async updateAuthorizationRequest(
    requestId: string,
    patch: Partial<AuthorizationRequestRecord>,
  ) {
    await db
      .update(fleetMcpOAuthAuthorizationRequests)
      .set(patch)
      .where(eq(fleetMcpOAuthAuthorizationRequests.id, requestId))
  }

  async saveAuthorizationCode(code: AuthorizationCodeRecord) {
    await db.insert(fleetMcpOAuthAuthorizationCodes).values(code)
  }

  async getAuthorizationCode(codeHash: string) {
    const rows = await db
      .select()
      .from(fleetMcpOAuthAuthorizationCodes)
      .where(eq(fleetMcpOAuthAuthorizationCodes.codeHash, codeHash))
    return rows[0] ? codeFromDb(rows[0]) : null
  }

  async updateAuthorizationCode(
    codeHash: string,
    patch: Partial<AuthorizationCodeRecord>,
  ) {
    await db
      .update(fleetMcpOAuthAuthorizationCodes)
      .set(patch)
      .where(eq(fleetMcpOAuthAuthorizationCodes.codeHash, codeHash))
  }

  // Conditional update: only the request that flips consumedAt from NULL gets a
  // row back, so concurrent code-exchange attempts can't both issue tokens.
  async consumeAuthorizationCode(codeHash: string, now: Date) {
    const rows = await db
      .update(fleetMcpOAuthAuthorizationCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(fleetMcpOAuthAuthorizationCodes.codeHash, codeHash),
          isNull(fleetMcpOAuthAuthorizationCodes.consumedAt),
        ),
      )
      .returning({ codeHash: fleetMcpOAuthAuthorizationCodes.codeHash })
    return rows.length > 0
  }

  async saveToken(tokenRecord: TokenRecord) {
    await db.insert(fleetMcpOAuthTokens).values(tokenRecord)
  }

  async getToken(tokenHash: string) {
    const rows = await db
      .select()
      .from(fleetMcpOAuthTokens)
      .where(eq(fleetMcpOAuthTokens.tokenHash, tokenHash))
    return rows[0] ? tokenFromDb(rows[0]) : null
  }

  async updateToken(tokenHash: string, patch: Partial<TokenRecord>) {
    await db
      .update(fleetMcpOAuthTokens)
      .set(patch)
      .where(eq(fleetMcpOAuthTokens.tokenHash, tokenHash))
  }

  // Conditional revoke: only one concurrent refresh wins, so a refresh token
  // can't be replayed into two valid token pairs.
  async revokeRefreshTokenIfActive(tokenHash: string, now: Date) {
    const rows = await db
      .update(fleetMcpOAuthTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(fleetMcpOAuthTokens.tokenHash, tokenHash),
          isNull(fleetMcpOAuthTokens.revokedAt),
        ),
      )
      .returning({ tokenHash: fleetMcpOAuthTokens.tokenHash })
    return rows.length > 0
  }

  async saveConsent(input: {
    userId: string
    clientId: string
    redirectUri: string
    resource: string
    scopes: string[]
  }) {
    const rows = await db
      .select()
      .from(fleetMcpOAuthConsents)
      .where(
        and(
          eq(fleetMcpOAuthConsents.userId, input.userId),
          eq(fleetMcpOAuthConsents.clientId, input.clientId),
          eq(fleetMcpOAuthConsents.redirectUri, input.redirectUri),
          eq(fleetMcpOAuthConsents.resource, input.resource),
        ),
      )

    if (rows[0]) {
      await db
        .update(fleetMcpOAuthConsents)
        .set({ scopes: input.scopes, updatedAt: new Date() })
        .where(eq(fleetMcpOAuthConsents.id, rows[0].id))
      return
    }

    await db.insert(fleetMcpOAuthConsents).values({
      id: randomUUID(),
      userId: input.userId,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scopes: input.scopes,
    })
  }
}

export function createFleetMcpOAuthService(req: Request) {
  const issuer = issuerFromRequest(req)
  return new FleetMcpOAuthService(
    isFleetMcpE2eMode() ? e2eOAuthStore() : new DbFleetMcpOAuthStore(),
    {
      issuer,
      resource: resourceFromIssuer(issuer),
    },
  )
}

export async function verifyFleetMcpBearerToken(
  req: Request,
  bearerToken?: string,
) {
  if (!bearerToken) return undefined
  const issuer = issuerFromRequest(req)
  const resource = resourceFromIssuer(issuer)
  const verified = await new FleetMcpOAuthService(
    isFleetMcpE2eMode() ? e2eOAuthStore() : new DbFleetMcpOAuthStore(),
    {
      issuer,
      resource,
    },
  ).verifyAccessToken(bearerToken, resource)
  return {
    ...verified,
    resource: new URL(verified.resource),
  }
}
