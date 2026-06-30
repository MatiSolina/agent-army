import { headers } from "next/headers"
import { redirect } from "next/navigation"
import {
  createFleetMcpOAuthService,
  FLEET_MCP_RESOURCE_PATH,
} from "@/lib/fleet-mcp/oauth"
import { getSessionUser } from "@/lib/session"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { fleetMcpE2eUser } from "@/lib/fleet-mcp/e2e"

async function currentOriginRequest() {
  const h = await headers()
  const proto = h.get("x-forwarded-proto") ?? "https"
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost"
  return new Request(`${proto}://${host}${FLEET_MCP_RESOURCE_PATH}`)
}

export default async function FleetMcpConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>
}) {
  const params = await searchParams
  const requestId = params.request ?? ""
  const user = fleetMcpE2eUser() ?? (await getSessionUser())
  if (!user) {
    redirect(`/sign-in?next=${encodeURIComponent(`/fleet-mcp/consent?request=${requestId}`)}`)
  }

  const service = createFleetMcpOAuthService(await currentOriginRequest())
  const request = requestId
    ? await service.getAuthorizationRequest(requestId)
    : null

  return (
    <main className="min-h-svh bg-background px-4 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
        <Card className="p-0">
          <CardHeader>
            <CardTitle>Authorize Fleet MCP access</CardTitle>
            <CardDescription>
              Review the client request before allowing remote control-plane tools.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!request ? (
              <p className="text-sm text-destructive">
                This authorization request is no longer available.
              </p>
            ) : (
              <dl className="grid gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Client</dt>
                  <dd className="break-all font-medium">{request.clientId}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Redirect URI</dt>
                  <dd className="break-all font-medium">{request.redirectUri}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Resource</dt>
                  <dd className="break-all font-medium">{request.resource}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Scopes</dt>
                  <dd className="font-medium">
                    {request.scopes.length ? request.scopes.join(", ") : "none"}
                  </dd>
                </div>
              </dl>
            )}
          </CardContent>
          {request && (
            <CardFooter className="justify-end gap-2">
              <form method="post" action="/api/fleet-mcp/oauth/consent">
                <input type="hidden" name="request" value={request.id} />
                <input type="hidden" name="decision" value="deny" />
                <Button type="submit" variant="outline">
                  Deny
                </Button>
              </form>
              <form method="post" action="/api/fleet-mcp/oauth/consent">
                <input type="hidden" name="request" value={request.id} />
                <input type="hidden" name="decision" value="approve" />
                <Button type="submit">Authorize</Button>
              </form>
            </CardFooter>
          )}
        </Card>
      </div>
    </main>
  )
}
