// The agent-editor action bar used to be five competing buttons plus two
// banners. The insight: a button can *carry its own state*. Save reflects the
// diff between the editor and the saved definition; Deploy reflects the diff
// between the saved definition and the live build. `attention` (an amber dot +
// a count) replaces the "you have undeployed build changes" warning banner:
// the alert lives on the button that resolves it.

type ButtonState = { label: string; disabled: boolean; attention: boolean }

// The header status pill. `enabled` ("Agent active") is a config preference that
// only means something once the agent actually lives in production. A freshly
// created, never-deployed agent is a Draft, not "Active". Live/Active is gated
// on a real deployment first, the toggle second.
//
// "Lives in production" is signalled by `deploymentUrl` (the promoted prod URL),
// NOT by `deploymentStatus`: staging a newer preview flips the status to
// "preview_ready" but does NOT clear the promoted prod URL, so the agent is
// still live. Keying off the URL keeps the editor, the agent list and
// observability in agreement.
export function agentStatusBadge(p: {
  enabled: boolean
  deploymentUrl: string | null
}): { label: string; live: boolean } {
  const live = p.deploymentUrl != null && p.deploymentUrl !== ""
  if (!live) return { label: "Draft", live: false }
  return p.enabled
    ? { label: "Active", live: true }
    : { label: "Inactive", live: false }
}

export function saveButtonState(p: {
  dirty: boolean
  saving: boolean
  changeCount: number
}): ButtonState {
  if (p.saving) return { label: "Saving…", disabled: true, attention: false }
  if (!p.dirty) return { label: "Saved", disabled: true, attention: false }
  return {
    label: p.changeCount > 0 ? `Save · ${p.changeCount}` : "Save changes",
    disabled: false,
    attention: true,
  }
}

// Auto-build on create: a from-template agent fires one preview build so the
// user lands on an already-building agent instead of an idle Draft. Gated to a
// never-deployed agent (so opening an existing one never redeploys) and to a
// single in-flight build.
export function shouldAutoBuild(p: {
  requested: boolean
  status: string | null
  deploying: boolean
}): boolean {
  if (!p.requested || p.deploying) return false
  return p.status == null || p.status === "none"
}

export function deployButtonState(p: {
  status: string
  deploying: boolean
  buildDirty: boolean
  needsDeploy: boolean
  changeCount: number
}): ButtonState & { busy: boolean } {
  if (p.deploying || p.status === "deploying")
    return { label: "Deploying…", disabled: true, attention: false, busy: true }
  // Save-then-deploy: unsaved build edits gate the Deploy CTA (the real diff is
  // computed server-side off the saved config, so there's nothing to count yet).
  if (p.buildDirty)
    return { label: "Deploy", disabled: true, attention: false, busy: false }
  if (p.needsDeploy)
    return {
      label: p.changeCount > 0 ? `Deploy · ${p.changeCount}` : "Deploy update",
      disabled: false,
      attention: true,
      busy: false,
    }
  if (p.status === "none")
    return { label: "Deploy", disabled: false, attention: false, busy: false }
  if (p.status === "failed")
    return { label: "Retry deploy", disabled: false, attention: true, busy: false }
  return { label: "Up to date", disabled: true, attention: false, busy: false }
}
