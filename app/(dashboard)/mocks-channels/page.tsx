import { ChannelsIslandsMock } from "@/components/dashboard/channels-islands-mock"
import { PageHeader } from "@/components/dashboard/page-header"

// note: dummy page, no server actions / no DB. Hardcoded shapes mirroring the
// real model: 1 channel = 1 agent (agentId per channel row). Islands grouped by type.
export default function MocksChannelsPage() {
  return (
    <>
      <PageHeader
        title="Channels — islands by type"
        description="Each island is one channel type. Inside, the apps you've connected and the agent each one maps to. Throwaway mock."
      />
      <ChannelsIslandsMock />
    </>
  )
}
