import { getChannelsForClient } from "@/app/actions/channels"
import { getAgents } from "@/app/actions/agents"
import { ChannelsView } from "@/components/dashboard/channels-view"

export default async function ChannelsPage() {
  const [channels, agents] = await Promise.all([
    getChannelsForClient(),
    getAgents(),
  ])
  return <ChannelsView initialChannels={channels} agents={agents} />
}
