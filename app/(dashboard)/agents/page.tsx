import { getAgents } from "@/app/actions/agents"
import { AgentsView } from "@/components/dashboard/agents-view"
import { resolveLatestEve } from "@/lib/eve/eve-version"

export default async function AgentsPage() {
  const [agents, eve] = await Promise.all([getAgents(), resolveLatestEve()])
  // Drifted = deployed bots whose eve pin is not the resolved target. Imported
  // agents are excluded: the dashboard does not own their deployment and can't
  // redeploy/eve-update them (they're update-only).
  const behindIds = agents
    .filter(
      (a) =>
        !a.imported &&
        a.deploymentStatus === "deployed" &&
        a.eveVersion !== eve.target,
    )
    .map((a) => a.id)
  return (
    <AgentsView
      initialAgents={agents}
      eve={eve}
      behindIds={behindIds}
    />
  )
}
