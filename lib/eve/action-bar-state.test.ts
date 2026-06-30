import { describe, it, expect } from "vitest"
import {
  saveButtonState,
  deployButtonState,
  agentStatusBadge,
  shouldAutoBuild,
} from "./action-bar-state"

describe("shouldAutoBuild", () => {
  it("builds a freshly-created, never-deployed agent when requested", () => {
    expect(shouldAutoBuild({ requested: true, status: "none", deploying: false })).toBe(true)
    expect(shouldAutoBuild({ requested: true, status: null, deploying: false })).toBe(true)
  })

  it("never builds unless the create flow asked for it", () => {
    expect(shouldAutoBuild({ requested: false, status: "none", deploying: false })).toBe(false)
  })

  it("won't re-build an agent that already has a deployment", () => {
    expect(shouldAutoBuild({ requested: true, status: "deployed", deploying: false })).toBe(false)
    expect(shouldAutoBuild({ requested: true, status: "preview_ready", deploying: false })).toBe(false)
  })

  it("won't double-fire while a build is already running", () => {
    expect(shouldAutoBuild({ requested: true, status: "none", deploying: true })).toBe(false)
  })
})

describe("agentStatusBadge", () => {
  it("is a Draft with no live production deployment, regardless of the enabled toggle", () => {
    expect(agentStatusBadge({ enabled: true, deploymentUrl: null })).toEqual({
      label: "Draft",
      live: false,
    })
    expect(agentStatusBadge({ enabled: true, deploymentUrl: "" })).toEqual({
      label: "Draft",
      live: false,
    })
  })

  it("is Active once it has a live production URL and the toggle is on", () => {
    expect(
      agentStatusBadge({ enabled: true, deploymentUrl: "https://x.vercel.app" }),
    ).toEqual({ label: "Active", live: true })
  })

  it("is Inactive when it has a production URL but the toggle is off", () => {
    expect(
      agentStatusBadge({ enabled: false, deploymentUrl: "https://x.vercel.app" }),
    ).toEqual({ label: "Inactive", live: false })
  })

  it("stays Active when a newer preview is staged over a live production URL (the bug)", () => {
    // deploymentStatus is now "preview_ready" but the promoted prod URL persists,
    // so the agent is still live, not "Offline"/"Draft".
    expect(
      agentStatusBadge({ enabled: true, deploymentUrl: "https://prod.vercel.app" }),
    ).toEqual({ label: "Active", live: true })
  })
})

describe("saveButtonState", () => {
  it("is idle when there is nothing to save", () => {
    expect(saveButtonState({ dirty: false, saving: false, changeCount: 0 })).toEqual({
      label: "Saved",
      disabled: true,
      attention: false,
    })
  })

  it("marks unsaved edits and carries the count", () => {
    expect(saveButtonState({ dirty: true, saving: false, changeCount: 3 })).toEqual({
      label: "Save · 3",
      disabled: false,
      attention: true,
    })
  })

  it("falls back to a wordy label when the count is unknown", () => {
    expect(saveButtonState({ dirty: true, saving: false, changeCount: 0 })).toEqual({
      label: "Save changes",
      disabled: false,
      attention: true,
    })
  })

  it("shows progress while saving", () => {
    expect(saveButtonState({ dirty: true, saving: true, changeCount: 3 })).toEqual({
      label: "Saving…",
      disabled: true,
      attention: false,
    })
  })
})

describe("deployButtonState", () => {
  const base = {
    status: "deployed",
    deploying: false,
    buildDirty: false,
    needsDeploy: false,
    changeCount: 0,
  } as const

  it("is idle and up to date when the live build matches", () => {
    expect(deployButtonState(base)).toEqual({
      label: "Up to date",
      disabled: true,
      attention: false,
      busy: false,
    })
  })

  it("marks drift with the diff count — this replaces the warning banner", () => {
    expect(deployButtonState({ ...base, needsDeploy: true, changeCount: 3 })).toEqual({
      label: "Deploy · 3",
      disabled: false,
      attention: true,
      busy: false,
    })
  })

  it("falls back to a wordy label when the drift count is unknown", () => {
    expect(deployButtonState({ ...base, needsDeploy: true, changeCount: 0 })).toEqual({
      label: "Deploy update",
      disabled: false,
      attention: true,
      busy: false,
    })
  })

  it("asks to save first when build edits are unsaved", () => {
    expect(
      deployButtonState({ ...base, buildDirty: true, needsDeploy: true, changeCount: 3 }),
    ).toEqual({ label: "Deploy", disabled: true, attention: false, busy: false })
  })

  it("is a plain CTA for the very first deploy", () => {
    expect(deployButtonState({ ...base, status: "none" })).toEqual({
      label: "Deploy",
      disabled: false,
      attention: false,
      busy: false,
    })
  })

  it("offers a retry after a failed deploy with no further drift", () => {
    expect(deployButtonState({ ...base, status: "failed" })).toEqual({
      label: "Retry deploy",
      disabled: false,
      attention: true,
      busy: false,
    })
  })

  it("shows progress while deploying (local flag)", () => {
    expect(deployButtonState({ ...base, deploying: true })).toEqual({
      label: "Deploying…",
      disabled: true,
      attention: false,
      busy: true,
    })
  })

  it("treats a deploying status as busy too", () => {
    expect(deployButtonState({ ...base, status: "deploying" })).toEqual({
      label: "Deploying…",
      disabled: true,
      attention: false,
      busy: true,
    })
  })
})
