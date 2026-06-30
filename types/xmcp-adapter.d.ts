declare module "@xmcp/adapter" {
  export type VerifyToken = (
    req: Request,
    bearerToken?: string,
  ) => Promise<
    | {
        token: string
        clientId: string
        scopes: string[]
        expiresAt?: number
        resource?: URL
        extra?: Record<string, unknown>
      }
    | undefined
  >

  export type AuthConfig = {
    verifyToken: VerifyToken
    required?: boolean
    requiredScopes?: string[]
  }

  export function xmcpHandler(request: Request): Promise<Response>
  export function withAuth(
    handler: (request: Request) => Promise<Response>,
    config: AuthConfig,
  ): (request: Request) => Promise<Response>
}
