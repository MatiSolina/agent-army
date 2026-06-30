"use client"

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { Agent, AgentHarness } from "@/lib/db/schema"
import type { ClientChannel } from "@/lib/channels/client-channel"
import type { ClientConnection } from "@/lib/mcp/client-connection"
import { updateAgentConfig, deleteAgent } from "@/app/actions/agents"
import { generateSystemPrompt } from "@/app/actions/generate-prompt"
import {
  deployAgent,
  promoteAgentDeployment,
  getAgentDeployments,
  testEvePreview,
} from "@/app/actions/deploy"
import { ModelSelect } from "@/components/dashboard/model-select"
import { LIMITS } from "@/lib/defaults"
import { validateCron } from "@/lib/validation"
import { withUniqueIds } from "@/lib/uid"
import { Button } from "@/components/ui/button"
import { DeleteAgentDialog } from "@/components/ui/delete-agent-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { ConfigChange } from "@/lib/eve/config-drift"
import { eveUpdateOffer, compareEve } from "@/lib/eve/eve-version"
import { buildEveVerifyHandoffPrompt } from "@/lib/eve/eve-verify-prompt"
import {
  saveButtonState,
  deployButtonState,
  agentStatusBadge,
  shouldAutoBuild,
} from "@/lib/eve/action-bar-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SkillsEditor,
  ConnectionsAssign,
  SubagentsEditor,
  SchedulesEditor,
} from "@/components/dashboard/agent-collections"
import { DeployProgressModal } from "@/components/dashboard/deploy-progress-modal"
import type { Deployment } from "@/components/dashboard/agent-deployments"
import {
  ChevronLeft,
  Trash2,
  MessageSquare,
  Terminal,
  ExternalLink,
  Rocket,
  Loader2,
  AlertTriangle,
  ArrowUpCircle,
  Sparkles,
  Copy,
} from "lucide-react"

// Occasional tabs (Test/Secrets/Deployments) are client-only and rarely the
// first thing a session opens, so defer their bundles until the tab is shown.
// The core edit tabs (General/Capabilities/Automation) stay eager to avoid
// tab-switch jank where most editing happens. (Deployments' data AND chunk are
// prefetched on mount (see below) so opening that tab is instant.)
const AgentPlayground = dynamic(
  () =>
    import("@/components/dashboard/agent-playground").then((m) => ({
      default: m.AgentPlayground,
    })),
  { ssr: false },
)
const AgentSecrets = dynamic(
  () =>
    import("@/components/dashboard/agent-secrets").then((m) => ({
      default: m.AgentSecrets,
    })),
  { ssr: false },
)
const AgentDeployments = dynamic(
  () =>
    import("@/components/dashboard/agent-deployments").then((m) => ({
      default: m.AgentDeployments,
    })),
  { ssr: false },
)

// Static option list for the sandbox runtime Select. Module scope keeps a stable
// reference across renders (base-ui Select needs the `items` prop for its value label).
const RUNTIME_OPTIONS = [
  { value: "node22", label: "Node.js 22" },
  { value: "node20", label: "Node.js 20" },
  { value: "python3.12", label: "Python 3.12" },
  { value: "python3.11", label: "Python 3.11" },
] as const

// Built-in eve tools the operator can turn off per agent. Each switch maps to one
// AgentHarness flag; ON = the agent keeps the tool. Turning a switch off makes the
// model literally unable to call that capability (a disableTool() file is emitted),
// which is the real guardrail for a customer-support bot, not just a prompt rule.
const HARNESS_TOOLS: { key: keyof AgentHarness; label: string; hint: string }[] = [
  { key: "bash", label: "Shell (bash)", hint: "Run shell commands in the sandbox." },
  { key: "files", label: "File tools", hint: "Read, write, glob and grep files." },
  { key: "webFetch", label: "Web fetch", hint: "Fetch arbitrary URLs." },
  { key: "webSearch", label: "Web search", hint: "Search the web." },
]

export function AgentEditor({
  agent,
  assignedChannels,
  allConnections,
  secretStatus,
  vercelObservabilityUrl,
  vercelEnvUrl,
  currentEveVersion,
  hasDrift,
  deployChanges,
}: {
  agent: Agent
  assignedChannels: ClientChannel[]
  allConnections: ClientConnection[]
  secretStatus: { key: string; configured: boolean }[]
  // Server-computed (lib/eve/config-drift): the SAVED config differs from the
  // config the live deployment was built from. Reliable hash compare, unlike a
  // naive updatedAt > lastDeployedAt check, which deploy/promote/failure all bump.
  hasDrift: boolean
  // Server-computed field-by-field diff of the saved config vs the deployed
  // snapshot, shown in the deploy confirm dialog (what will change in prod).
  deployChanges: ConfigChange[]
  // The CANDIDATE eve version (npm `latest`), compared to agent.eveVersion to
  // drive the eve-version affordances: a non-gated patch shows "Update to <v>",
  // a gated (breaking) bump shows the "Test <v>" preview-test (and, once this
  // agent verifies it, the un-gated "Update to <v>"). NOT the auto-update target
  // for a gated bump that is pinned back to the current version. deployAgent
  // re-resolves the real pin server-side from this agent's verified verdict.
  currentEveVersion: string
  // Finished deep-link to the deployed project's Vercel Observability page.
  // Built server-side from VERCEL_TEAM_SLUG; undefined when unset or undeployed
  // (the env value itself is never sent to the client). Hidden when falsy.
  vercelObservabilityUrl?: string
  // Deep-link to the Vercel project's Environment Variables page, where secrets
  // are edited/rotated. Same gating as above; undefined hides the link.
  vercelEnvUrl?: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const modelLabelId = useId()
  const tempLabelId = useId()
  // Whether to offer the manual "Update Eve" button. Same gate logic as the fleet
  // auto-update workflow (compareEve): never a downgrade, never a breaking bump.
  const eveOffer = useMemo(
    () => eveUpdateOffer(agent.eveVersion, currentEveVersion, agent.eveVerifiedVersion),
    [agent.eveVersion, currentEveVersion, agent.eveVerifiedVersion],
  )
  // A gated (breaking) bump is available for this agent's deployed eve version.
  // The Test button preview-tests the candidate; a green verdict un-gates the
  // Update via eveOffer above (eveVerifiedVersion === currentEveVersion).
  const eveGate = useMemo(
    () =>
      agent.eveVersion ? compareEve(agent.eveVersion, currentEveVersion) : null,
    [agent.eveVersion, currentEveVersion],
  )
  const gatedBumpAvailable = !!eveGate?.gated
  // Preview-test progress + verdict (server action testEvePreview).
  const [eveTesting, setEveTesting] = useState(false)
  const [eveVerifyError, setEveVerifyError] = useState<string | null>(
    agent.eveVerifyError,
  )
  const handoffPrompt =
    eveVerifyError && agent.eveVersion
      ? buildEveVerifyHandoffPrompt({
          agentName: agent.name,
          fromVersion: agent.eveVersion,
          toVersion: currentEveVersion,
          error: eveVerifyError,
        })
      : null
  // Whether the candidate is a gated (breaking) bump that this agent has NOT yet
  // verified. Those go through a safety preview-test before the prod update;
  // the user just sees one "Update Eve to <v>" button (runEveUpdate below).
  const gatedUpdateNeedsTest =
    agent.deploymentStatus === "deployed" &&
    !!agent.eveVersion &&
    gatedBumpAvailable &&
    agent.eveVerifiedVersion !== currentEveVersion
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmDeploy, setConfirmDeploy] = useState(false)
  const [deploying, setDeploying] = useState(false)
  // Live redeploy modal: tracks when the deploy started (so progress polling
  // ignores prior builds) and whether deployAgent rejected before any Vercel
  // deployment was created (project/env error → modal would sit on "preparing").
  const [deployModalOpen, setDeployModalOpen] = useState(false)
  const [deploySince, setDeploySince] = useState(0)
  const [deployFailed, setDeployFailed] = useState(false)
  // Controlled so the deploy modal's "Test preview" can jump straight to the
  // Test tab (which chats against the fresh preview build).
  const [tab, setTab] = useState("general")

  // ----- editable state -----
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description ?? "")
  const [enabled, setEnabled] = useState(agent.enabled)
  const [model, setModel] = useState(agent.model)
  const [temperature, setTemperature] = useState(agent.temperature)
  const [maxSteps, setMaxSteps] = useState(agent.maxSteps)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [promptIdea, setPromptIdea] = useState("")
  const [generating, setGenerating] = useState(false)

  const handleGeneratePrompt = async () => {
    if (!promptIdea.trim()) return
    setGenerating(true)
    try {
      setInstructions(await generateSystemPrompt(promptIdea))
      toast.success("Draft generated — edit as needed")
    } catch {
      toast.error("Could not generate the prompt")
    } finally {
      setGenerating(false)
    }
  }
  const [skills, setSkills] = useState(() => withUniqueIds(agent.skills))
  // MCP connections are global; the agent stores assigned ids only.
  // Drop ids that no longer point at an existing global entity.
  const [connectionIds, setConnectionIds] = useState<string[]>(() =>
    (agent.connectionIds ?? []).filter((id) =>
      allConnections.some((c) => c.id === id),
    ),
  )
  const [subagents, setSubagents] = useState(() =>
    withUniqueIds(agent.subagents),
  )
  const [schedules, setSchedules] = useState(() =>
    withUniqueIds(agent.schedules),
  )
  const [sandbox, setSandbox] = useState(agent.sandbox)
  const [harness, setHarness] = useState(agent.harness ?? {})

  // Unsaved-edit detection. Compare the live editable state to the SAVED agent,
  // normalized the SAME way the state was initialized (withUniqueIds is a no-op
  // for unique DB ids + the same connectionIds filter), so an untouched form is
  // never reported dirty. After save/deploy, router.refresh() feeds a fresh
  // `agent` prop and this recomputes to false.
  const savedConfig = useMemo(
    () =>
      JSON.stringify({
        name: agent.name,
        description: agent.description ?? "",
        enabled: agent.enabled,
        model: agent.model,
        temperature: agent.temperature,
        maxSteps: agent.maxSteps,
        instructions: agent.instructions,
        skills: withUniqueIds(agent.skills),
        connectionIds: (agent.connectionIds ?? []).filter((id) =>
          allConnections.some((c) => c.id === id),
        ),
        subagents: withUniqueIds(agent.subagents),
        schedules: withUniqueIds(agent.schedules),
        sandbox: agent.sandbox,
      }),
    [agent, allConnections],
  )
  const currentConfig = JSON.stringify({
    name,
    description,
    enabled,
    model,
    temperature,
    maxSteps,
    instructions,
    skills,
    connectionIds,
    subagents,
    schedules,
    sandbox,
  })
  const dirty = currentConfig !== savedConfig
  const savedBuildConfig = JSON.stringify({
    name: agent.name,
    description: agent.description ?? "",
    model: agent.model,
    temperature: agent.temperature,
    maxSteps: agent.maxSteps,
    skills: withUniqueIds(agent.skills),
    connectionIds: allConnections
      .filter((c) => agent.connectionIds.includes(c.id))
      .map((c) => c.id),
    subagents: withUniqueIds(agent.subagents),
    schedules: withUniqueIds(agent.schedules),
    sandbox: agent.sandbox,
  })
  const currentBuildConfig = JSON.stringify({
    name,
    description,
    model,
    temperature,
    maxSteps,
    skills,
    connectionIds,
    subagents,
    schedules,
    sandbox,
  })
  const buildDirty = currentBuildConfig !== savedBuildConfig
  // The live/built agent is stale when there are unsaved structural edits OR the
  // saved build config drifted from the deployed snapshot. Runtime instructions
  // are intentionally excluded: saving them updates live agents on the next turn.
  const needsDeploy =
    agent.deploymentStatus !== "none" &&
    agent.deploymentStatus !== "deploying" &&
    (buildDirty || hasDrift)

  // How many fields differ from the saved definition; drives the "Save · N"
  // count. Cheap shallow compare over the same objects `dirty` is built from.
  const saveChangeCount = useMemo(() => {
    const a = JSON.parse(savedConfig) as Record<string, unknown>
    const b = JSON.parse(currentConfig) as Record<string, unknown>
    return Object.keys(b).filter(
      (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
    ).length
  }, [savedConfig, currentConfig])

  // The two buttons carry their own state (label + amber dot + count), which is
  // why the old "undeployed build changes" banner below is gone. See
  // lib/eve/action-bar-state.ts.
  const saveState = saveButtonState({
    dirty,
    saving: isPending,
    changeCount: saveChangeCount,
  })
  const deployState = deployButtonState({
    status: agent.deploymentStatus ?? "none",
    deploying,
    buildDirty,
    needsDeploy,
    changeCount: deployChanges.length,
  })
  // "Active" only once the agent actually lives in prod; never-deployed = Draft.
  // Uses the live `enabled` toggle so the pill reacts as the user flips it.
  const statusBadge = agentStatusBadge({
    enabled,
    deploymentUrl: agent.deploymentUrl ?? null,
  })

  // Deployments live here (not in the Deployments tab) so the Vercel REST fetch
  // starts the moment the agent is selected; by the time the user opens the tab
  // the list is already loaded instead of showing a spinner. `null` = first load.
  const [deployments, setDeployments] = useState<Deployment[] | null>(null)
  const [loadingDeployments, startLoadingDeployments] = useTransition()
  const loadDeployments = useCallback(() => {
    startLoadingDeployments(async () => {
      setDeployments(await getAgentDeployments(agent.id))
    })
  }, [agent.id])

  useEffect(() => {
    loadDeployments()
    // Also warm the lazy chunk so the tab itself opens with no flash.
    import("@/components/dashboard/agent-deployments")
  }, [loadDeployments])

  // Auto-build on create: a from-template agent lands here with ?building=1 and
  // kicks off one preview build in the background (no modal, you configure
  // while it builds). Ref-guarded + server CAS-locked so it can't double-fire;
  // the flag is dropped from the URL so a refresh won't re-trigger it.
  const autoBuildFired = useRef(false)
  useEffect(() => {
    if (autoBuildFired.current) return
    const requested =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("building") === "1"
    if (
      !shouldAutoBuild({
        requested,
        status: agent.deploymentStatus ?? null,
        deploying,
      })
    )
      return
    autoBuildFired.current = true
    router.replace(window.location.pathname, { scroll: false })
    // setTimeout so the deploy's setState isn't called synchronously in the
    // effect body (cascading-render lint rule).
    setTimeout(() => {
      setDeploying(true)
      deployAgent(agent.id)
        .then(() => {
          router.refresh()
          loadDeployments()
        })
        .catch(() => {
          setDeployFailed(true)
          toast.error("Build failed")
          router.refresh()
        })
        .finally(() => setDeploying(false))
    }, 0)
  }, [agent.id, agent.deploymentStatus, deploying, router, loadDeployments])

  const save = () => {
    if (!name.trim()) {
      toast.error("The agent needs a name")
      return
    }
    // Block saving while any schedule cron is invalid so we never persist
    // malformed config.
    const badSchedule = schedules.find((s) => validateCron(s.cron))
    if (badSchedule) {
      toast.error(
        `Check the cron for "${badSchedule.name || "unnamed schedule"}" in Automation › Schedules.`,
      )
      return
    }
    startTransition(async () => {
      try {
        await updateAgentConfig(agent.id, {
          name: name.trim(),
          description,
          enabled,
          model,
          temperature,
          maxSteps,
          instructions,
          skills,
          connectionIds,
          subagents,
          schedules,
          sandbox,
          harness,
        })
        toast.success("Changes saved")
        router.refresh()
      } catch {
        toast.error("Could not save changes")
      }
    })
  }

  // Entry point for every Deploy button. The first deploy has nothing to diff
  // against, so it ships straight away; a redeploy opens a confirm dialog that
  // shows what will change in production before spending a real Vercel build.
  const requestDeploy = () => {
    if (agent.deploymentStatus === "none" || !agent.deployedConfig) {
      runDeploy()
      return
    }
    setConfirmDeploy(true)
  }

  const runDeploy = () => {
    setConfirmDeploy(false)
    // Open the live-progress modal and stamp the start time so its polling
    // ignores any earlier build. deployAgent runs in the background; the modal
    // streams Vercel's real build state via the deploy-progress route.
    setDeployFailed(false)
    setDeploySince(Date.now())
    setDeployModalOpen(true)
    setDeploying(true)
    // Fire-and-track outside startTransition: the modal owns the UX now, and we
    // must not block the route-handler polls behind this server action.
    deployAgent(agent.id)
      .then(() => {
        router.refresh()
        loadDeployments()
      })
      .catch(() => {
        setDeployFailed(true)
        toast.error("Deploy failed")
        router.refresh()
      })
      .finally(() => setDeploying(false))
  }

  // One-click "Update Eve to <v>" for a gated (breaking) bump: silently
  // preview-test the candidate first, and only roll it out to prod if it
  // passes. A failure surfaces the copy-paste handoff prompt instead. The user
  // never sees a separate "Test" step; the safety check is invisible.
  const runEveUpdate = async () => {
    setEveTesting(true)
    try {
      const out = await testEvePreview(agent.id, currentEveVersion)
      if (out.verdictUrl) {
        // Verified green → deploy the candidate to prod (deployAgent ships the
        // candidate now that eveVerifiedVersion === the latest target).
        setEveVerifyError(null)
        runDeploy()
      } else {
        setEveVerifyError(out.error ?? "Preview-test failed")
        toast.error(`Eve ${currentEveVersion} update failed its safety test`)
      }
    } catch {
      setEveVerifyError("Preview-test failed")
      toast.error("Update failed")
    } finally {
      setEveTesting(false)
    }
  }

  // Promote the pending preview straight from the header CTA (the same action
  // backs each row in the Deployments tab). Guards a null previewDeploymentId.
  const promotePreview = () => {
    if (!agent.previewDeploymentId) return
    const deploymentId = agent.previewDeploymentId
    startTransition(async () => {
      try {
        await promoteAgentDeployment(agent.id, deploymentId)
        toast.success("Published to production")
        router.refresh()
        loadDeployments()
      } catch {
        toast.error("Could not publish to production")
      }
    })
  }

  const handleDelete = () => {
    startTransition(async () => {
      try {
        await deleteAgent(agent.id)
        toast.success("Agent deleted")
        router.push("/agents")
      } catch {
        toast.error("Could not delete the agent")
        setConfirmDelete(false)
      }
    })
  }

  const counts = {
    skills: skills.length,
    connections: connectionIds.length,
    subagents: subagents.length,
    schedules: schedules.length,
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb + actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            href="/agents"
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            Agents
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="font-mono font-medium text-foreground">
            {name || "untitled"}
          </span>
          <span
            className="ml-1 flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
            aria-label={statusBadge.label}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                statusBadge.live ? "bg-success" : "bg-muted-foreground"
              }`}
              aria-hidden="true"
            />
            {statusBadge.label}
          </span>
          {(deploying || agent.deploymentStatus === "deploying") && (
            <span className="ml-1 flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Deploying…
            </span>
          )}
          {!deploying && agent.deploymentStatus === "deployed" && (
            <span
              className="ml-1 flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              title={agent.deploymentUrl ?? undefined}
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-success"
                aria-hidden="true"
              />
              Deployed
            </span>
          )}
          {!deploying && agent.deploymentStatus === "failed" && (
            <span
              className="ml-1 flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-destructive"
              title={agent.deploymentError ?? undefined}
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-destructive"
                aria-hidden="true"
              />
              Deploy failed
            </span>
          )}
          {/* Informational badge of the Eve version this agent is deployed on.
              The "update available" affordance is the full-width banner below,
              not a link buried in this pill. */}
          {agent.deploymentStatus === "deployed" && agent.eveVersion && (
            <span className="ml-1 flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              Eve {agent.eveVersion}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Deep-link to the deployed project's Vercel Observability page, a
              SEPARATE destination from the "Deployed" badge (which points at the
              runtime URL). Hidden unless the page supplied a finished URL. */}
          {vercelObservabilityUrl && (
            <a
              href={vercelObservabilityUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open in Vercel
            </a>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            disabled={isPending}
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
          <Button
            variant={deployState.disabled ? "secondary" : "default"}
            size="sm"
            onClick={requestDeploy}
            disabled={isPending || deployState.disabled}
            className="gap-1.5"
            title={
              buildDirty
                ? "Save your changes first, then deploy"
                : "Deploys the saved configuration as its own Eve Vercel project"
            }
          >
            {deployState.busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : deployState.attention ? (
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
                aria-hidden="true"
              />
            ) : null}
            {deployState.label}
          </Button>
          <Button
            variant={saveState.disabled ? "secondary" : "default"}
            onClick={save}
            disabled={isPending || saveState.disabled}
            size="sm"
            className="gap-1.5"
          >
            {saveState.attention && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
                aria-hidden="true"
              />
            )}
            {saveState.label}
          </Button>
        </div>
      </div>

      {/* "Update Eve" affordance: a prominent full-width banner, not a link in
          a pill. For a gated (breaking) bump we run a silent preview-test first
          (runEveUpdate) and only roll out if it passes; for a patch/verified
          bump we deploy directly (requestDeploy). Either way the CTA reads
          "Update Eve to <v>" so it's unambiguous. */}
      {agent.deploymentStatus === "deployed" &&
        agent.eveVersion &&
        (eveOffer.show || gatedUpdateNeedsTest) && (
          <div
            className={`flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between ${
              gatedUpdateNeedsTest
                ? "border-amber-500/40 bg-amber-500/5"
                : "border-border bg-secondary/50"
            }`}
          >
            <span className="flex items-start gap-2 text-foreground">
              {gatedUpdateNeedsTest ? (
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
                  aria-hidden="true"
                />
              ) : (
                <ArrowUpCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">
                  Eve {currentEveVersion} available
                  {gatedUpdateNeedsTest ? " — breaking update" : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {gatedUpdateNeedsTest
                    ? "We'll test it on this agent first, then update only if it passes."
                    : "Update this agent to the latest Eve runtime."}
                </span>
              </span>
            </span>
            <Button
              size="sm"
              onClick={gatedUpdateNeedsTest ? runEveUpdate : requestDeploy}
              disabled={eveTesting || deploying}
              className="shrink-0 gap-1.5"
            >
              {(eveTesting || deploying) && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {eveTesting
                ? `Testing ${currentEveVersion}…`
                : deploying
                  ? "Updating…"
                  : `Update Eve to ${currentEveVersion}`}
            </Button>
          </div>
        )}

      {/* Gated eve-bump preview-test FAILURE handoff. The prompt is composed on
          render from eveVersion + currentEveVersion + the raw error (never stored
          in the DB), so improving the copy never leaves stale prompts cached. The
          fix lives upstream in this repo's generator, so the prompt points there.
          Monospace + a Copy button make the handoff easy to paste into a coding
          agent. */}
      {agent.deploymentStatus === "deployed" && handoffPrompt && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <span className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Eve {currentEveVersion} preview-test failed — hand this to a coding
            agent to fix the generator:
          </span>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
            {handoffPrompt}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(handoffPrompt)
                  .then(() => toast.success("Prompt copied"))
                  .catch(() => toast.error("Could not copy"))
              }}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy prompt
            </Button>
          </div>
        </div>
      )}

      {/* Actionable notices: full-width banners, not status pills. A long
          sentence + actions never fit a rounded-full pill on a phone; they
          stack cleanly here (message on top, actions below; inline on ≥sm). */}
      {!deploying &&
        agent.deploymentStatus === "preview_ready" &&
        agent.previewUrl && (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2 text-foreground">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                aria-hidden="true"
              />
              Preview ready — test it before publishing
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTab("playground")}
                title="Test this preview build in the dashboard"
              >
                Open
              </Button>
              <Button
                size="sm"
                onClick={promotePreview}
                disabled={isPending || !agent.previewDeploymentId}
              >
                Promote to production
              </Button>
            </div>
          </div>
        )}

      <Tabs value={tab} onValueChange={setTab}>
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] md:[mask-image:none]">
          <TabsList variant="line" className="w-max">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="capabilities">
              Capabilities ({counts.skills + counts.connections + counts.subagents})
            </TabsTrigger>
            <TabsTrigger value="automation">
              Automation ({counts.schedules})
            </TabsTrigger>
            <TabsTrigger value="channels">
              Channels ({assignedChannels.length})
            </TabsTrigger>
            <TabsTrigger value="deployments">Deployments</TabsTrigger>
            <TabsTrigger value="secrets">Secrets</TabsTrigger>
            <TabsTrigger value="playground">Test</TabsTrigger>
          </TabsList>
        </div>

        {/* General: Identity + Model/runtime + Instructions */}
        <TabsContent value="general" className="mt-6 space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4 rounded-xl border border-border p-5">
              <h3 className="text-sm font-medium text-foreground">Identity</h3>
              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-xs text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="WhatsApp Support"
                  maxLength={LIMITS.agentName}
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="description"
                  className="text-xs text-muted-foreground"
                >
                  Description
                </Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Handles customer questions via WhatsApp"
                  maxLength={LIMITS.agentDescription}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div className="space-y-0.5">
                  <Label
                    htmlFor="enabled"
                    className="text-sm font-medium text-foreground"
                  >
                    Agent active
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When inactive, the agent will not respond in its channels.
                  </p>
                </div>
                <Switch
                  id="enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-border p-5">
              <h3 className="text-sm font-medium text-foreground">
                Model and runtime
              </h3>
              <div className="space-y-1.5">
                <Label id={modelLabelId} className="text-xs text-muted-foreground">
                  Model
                </Label>
                <ModelSelect
                  value={model}
                  onValueChange={setModel}
                  ariaLabelledby={modelLabelId}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label id={tempLabelId} className="text-xs text-muted-foreground">
                    Temperature
                  </Label>
                  <span className="font-mono text-xs tabular-nums text-foreground">
                    {(temperature / 100).toFixed(2)}
                  </span>
                </div>
                <Slider
                  aria-labelledby={tempLabelId}
                  value={[temperature]}
                  onValueChange={(v) =>
                    setTemperature(Array.isArray(v) ? v[0] : v)
                  }
                  min={0}
                  max={100}
                  step={5}
                />
                <p className="text-xs text-muted-foreground/70">
                  Lower = more deterministic responses; higher = more creative.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="maxSteps"
                  className="text-xs text-muted-foreground"
                >
                  Max steps
                </Label>
                <Input
                  id="maxSteps"
                  type="number"
                  min={1}
                  max={50}
                  value={maxSteps}
                  onChange={(e) =>
                    setMaxSteps(Number(e.target.value) || 1)
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground/70">
                  Tool-calling iteration limit per turn.
                </p>
              </div>
            </div>
          </div>

          {/* Instructions */}
          <div className="space-y-3 rounded-xl border border-border p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h3 className="font-mono text-sm font-medium text-foreground">
                  Runtime instructions
                </h3>
                <p className="text-xs text-muted-foreground">
                  The live system prompt that defines who the agent is and how
                  it behaves.
                </p>
              </div>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
                {instructions.length}/{LIMITS.instructions}
              </span>
            </div>
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-2">
                <Sparkles className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  value={promptIdea}
                  onChange={(e) => setPromptIdea(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      handleGeneratePrompt()
                    }
                  }}
                  placeholder="Describe what this agent should do…"
                  className="h-8 border-0 bg-transparent px-0 focus-visible:ring-0"
                  disabled={generating}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleGeneratePrompt}
                disabled={generating || !promptIdea.trim()}
                className="shrink-0 gap-1.5"
              >
                {generating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                Generate with AI
              </Button>
            </div>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={LIMITS.instructions}
              aria-label="Agent runtime instructions"
              className="min-h-72 font-mono text-xs leading-relaxed"
              placeholder="You are a support assistant for..."
            />
          </div>
        </TabsContent>

        {/* Capabilities: Skills + Connections + Subagents.
            Tools are MCP-only: they come from assigned MCP connections, not a
            separate custom-tools surface. */}
        <TabsContent value="capabilities" className="mt-6 space-y-10">
          <section>
            <SkillsEditor value={skills} onChange={setSkills} />
          </section>
          <div className="border-t border-border" />
          <section>
            <ConnectionsAssign
              available={allConnections}
              value={connectionIds}
              onChange={setConnectionIds}
            />
          </section>
          <div className="border-t border-border" />
          <section>
            <SubagentsEditor value={subagents} onChange={setSubagents} />
          </section>
        </TabsContent>

        {/* Automation: Sandbox + Schedules */}
        <TabsContent value="automation" className="mt-6 space-y-10">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-foreground">Sandbox</h3>
                <p className="text-xs text-muted-foreground">
                  A controlled workspace where the agent can create files and
                  execute commands.
                </p>
              </div>
              <Switch
                checked={sandbox.enabled}
                onCheckedChange={(checked) =>
                  setSandbox({ ...sandbox, enabled: checked })
                }
              />
            </div>

            {sandbox.enabled ? (
              <div className="space-y-4 rounded-xl border border-border p-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Runtime
                    </Label>
                    <Select
                      items={RUNTIME_OPTIONS}
                      value={sandbox.runtime ?? "node22"}
                      onValueChange={(v) =>
                        setSandbox({ ...sandbox, runtime: v ?? "node22" })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="node22">Node.js 22</SelectItem>
                        <SelectItem value="node20">Node.js 20</SelectItem>
                        <SelectItem value="python3.12">Python 3.12</SelectItem>
                        <SelectItem value="python3.11">Python 3.11</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Timeout (ms)
                    </Label>
                    <Input
                      type="number"
                      min={1000}
                      step={1000}
                      value={sandbox.timeoutMs ?? 30000}
                      onChange={(e) =>
                        setSandbox({
                          ...sandbox,
                          timeoutMs: Number(e.target.value) || 30000,
                        })
                      }
                      className="font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Setup commands
                  </Label>
                  <Textarea
                    value={sandbox.setupCommands ?? ""}
                    onChange={(e) =>
                      setSandbox({
                        ...sandbox,
                        setupCommands: e.target.value,
                      })
                    }
                    placeholder={"npm install\nnpm run build"}
                    maxLength={LIMITS.sandboxSetup}
                    className="min-h-28 font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground/70">
                    One command per line, executed when the sandbox initializes.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
                  <Terminal className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="max-w-sm text-xs text-muted-foreground">
                  The sandbox is disabled. Enable it to let the agent execute
                  commands and handle files.
                </p>
              </div>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Built-in tools: guardrails */}
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">
                Built-in tools
              </h3>
              <p className="text-xs text-muted-foreground">
                Capabilities the deployed agent ships with. Turn one off and the
                model can&apos;t use it, whatever it&apos;s asked — turn them all
                off for a customer-support bot that should only chat and use its
                connections.
              </p>
            </div>
            <div className="divide-y divide-border rounded-xl border border-border">
              {HARNESS_TOOLS.map(({ key, label, hint }) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-4 px-5 py-3.5"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm text-foreground">{label}</p>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                  <Switch
                    checked={harness[key] !== false}
                    onCheckedChange={(on) =>
                      setHarness((prev) => {
                        // Keep `{}` (full harness) when on, so an untouched agent
                        // never reads as config drift. Only persist explicit offs.
                        const next = { ...prev }
                        if (on) delete next[key]
                        else next[key] = false
                        return next
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* Schedules */}
          <section>
            <SchedulesEditor value={schedules} onChange={setSchedules} />
          </section>
        </TabsContent>

        {/* Channels (read-only) */}
        <TabsContent value="channels" className="mt-6">
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">
                Assigned channels
              </h3>
              <p className="text-xs text-muted-foreground">
                The channels where this agent responds. Assignment is managed
                from each channel.
              </p>
            </div>
            {assignedChannels.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-12 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
                  <MessageSquare className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="max-w-sm text-xs text-muted-foreground">
                  This agent is not assigned to any channel yet.
                </p>
                <Button variant="secondary" size="sm" render={<Link href="/channels" />} nativeButton={false}>
                  Go to channels
                </Button>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border">
                <ul className="divide-y divide-border">
                  {assignedChannels.map((channel) => (
                    <li
                      key={channel.id}
                      className="flex items-center gap-3 px-4 py-3"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
                        <MessageSquare className="h-4 w-4 text-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {channel.name}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {channel.type}
                          {channel.kapsoPhoneNumberId
                            ? ` · ${channel.kapsoPhoneNumberId}`
                            : ""}
                        </p>
                      </div>
                      <Link
                        href="/channels"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="View channel"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Deployments: list past deploys, promote/rollback to any one */}
        <TabsContent value="deployments" className="mt-6">
          <AgentDeployments
            agentId={agent.id}
            deployments={deployments}
            loading={loadingDeployments}
            onReload={loadDeployments}
          />
        </TabsContent>

        {/* Secrets: per-agent env vars stored on its Vercel project */}
        <TabsContent value="secrets" className="mt-6">
          <AgentSecrets status={secretStatus} vercelEnvUrl={vercelEnvUrl} />
        </TabsContent>

        {/* Playground: in-browser test chat */}
        <TabsContent value="playground" className="mt-6">
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">
                Test the agent
              </h3>
              <p className="text-xs text-muted-foreground">
                Chat with the agent&apos;s runtime. When a preview is pending this
                tests the preview before you publish; otherwise it hits the live
                production runtime. Prompt edits apply on the next turn;
                re-deploy structural changes.
              </p>
            </div>
            <AgentPlayground
              agentId={agent.id}
              deploymentStatus={agent.deploymentStatus}
              deploymentUrl={agent.deploymentUrl}
              previewUrl={agent.previewUrl}
            />
          </div>
        </TabsContent>
      </Tabs>

      <DeleteAgentDialog
        open={confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(false)}
        agentName={agent.name}
        onConfirm={handleDelete}
        loading={isPending}
      />

      {/* Pre-deploy confirm: shows the field-by-field diff vs the live build so
          the user sees what a real (billable) Vercel deploy will change. */}
      <Dialog open={confirmDeploy} onOpenChange={setConfirmDeploy}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Deploy to production</DialogTitle>
            <DialogDescription>
              {deployChanges.length > 0
                ? "These changes will go live when the new build is promoted:"
                : "No config changes since the last deploy. Redeploy anyway?"}
            </DialogDescription>
          </DialogHeader>

          {deployChanges.length > 0 && (
            <ul className="space-y-1.5 rounded-lg border border-border bg-secondary/40 p-3 text-sm">
              {deployChanges.map((c) => (
                <li
                  key={c.field}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-foreground">{c.label}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {c.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {dirty && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              You have unsaved edits — they won&apos;t be deployed. Save first to
              include them.
            </p>
          )}

          <DialogFooter className="mt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDeploy(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={runDeploy} className="gap-1.5">
              <Rocket className="h-4 w-4" aria-hidden="true" />
              Deploy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeployProgressModal
        key={deploySince}
        agentId={agent.id}
        open={deployModalOpen}
        onOpenChange={setDeployModalOpen}
        since={deploySince}
        failed={deployFailed}
        onTestPreview={() => {
          // Pull the now-preview_ready agent row so the Test tab enters
          // preview-test mode, then close the modal and switch to it.
          router.refresh()
          setTab("playground")
          setDeployModalOpen(false)
        }}
      />
    </div>
  )
}
