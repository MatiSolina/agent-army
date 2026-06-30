import { notFound } from "next/navigation"
import {
  getAgentBySlug,
  getAgentChannelsForClient,
} from "@/app/actions/agents"
import { getConnectionsForClient } from "@/app/actions/connections"
import { getAgentSecretStatus } from "@/app/actions/secrets"
import { AgentEditor } from "@/components/dashboard/agent-editor"
import { ImportedAgentEditor } from "@/components/dashboard/imported-agent-editor"
import { getVercelTeamSlug } from "@/lib/vercel/team-slug"
import { buildVercelDashboardUrls } from "@/lib/vercel/dashboard-url"
import { projectName } from "@/lib/eve/project"
import { resolveLatestEve } from "@/lib/eve/eve-version"
import { hasConfigDrift, diffDeployedConfig } from "@/lib/eve/config-drift"

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // `id` is the name slug (with a fallback to a raw id for old links). Resolve
  // the agent first, then fetch its channels/secrets by the real id.
  const { id } = await params
  const agent = await getAgentBySlug(id)
  if (!agent) notFound()

  // Imported agents are update-only: render the minimal prompt editor and skip
  // the channels/connections/secrets/eve fetches the full editor needs.
  if (agent.imported) {
    return <ImportedAgentEditor agent={agent} />
  }

  const [assignedChannels, allConnections, secretStatus, eve] = await Promise.all([
    getAgentChannelsForClient(agent.id),
    getConnectionsForClient(),
    getAgentSecretStatus(agent.id),
    resolveLatestEve(),
  ])

  // Deep-links into the deployed project's Vercel dashboard. Lazy: derive the
  // slug from the team env var + projectName(agent); only build URLs when both
  // the team slug is configured and the agent is actually deployed (no Vercel
  // project exists before that). Never pass the env value to the client — only
  // the finished URL strings.
  const teamSlug = getVercelTeamSlug()
  const vercelUrls =
    teamSlug && agent.deploymentStatus === "deployed"
      ? buildVercelDashboardUrls({ teamSlug, projectName: projectName(agent) })
      : undefined

  return (
    <AgentEditor
      agent={agent}
      assignedChannels={assignedChannels}
      allConnections={allConnections}
      secretStatus={secretStatus}
      vercelObservabilityUrl={vercelUrls?.observability}
      // Vercel project's Environment Variables page — where secrets are actually
      // edited/rotated. They are injected at deploy time, not from this UI.
      vercelEnvUrl={
        vercelUrls && `${vercelUrls.project}/settings/environment-variables`
      }
      // The CANDIDATE the editor reasons about: the npm `latest`, NOT the
      // auto-update `target` (which, for a gated bump, is pinned BACK to the
      // current version). The gate detection, the "Test <candidate>" button, the
      // verified "Update to <candidate>" offer and the failure handoff all key
      // off this. deployAgent re-resolves the real pin server-side (keeps a gated
      // bump pinned unless this agent verified it).
      currentEveVersion={eve.latest}
      hasDrift={hasConfigDrift(agent)}
      deployChanges={diffDeployedConfig(agent.deployedConfig, agent)}
    />
  )
}
