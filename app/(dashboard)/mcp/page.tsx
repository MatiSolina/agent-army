import { Suspense } from "react"
import { getConnectionsForClient } from "@/app/actions/connections"
import { McpView } from "@/components/dashboard/mcp-view"

export default async function McpPage() {
  const connections = await getConnectionsForClient()
  // McpView reads useSearchParams (OAuth redirect flag), which requires a
  // Suspense boundary so the page can still be statically prerendered.
  return (
    <Suspense fallback={null}>
      <McpView initialConnections={connections} />
    </Suspense>
  )
}
