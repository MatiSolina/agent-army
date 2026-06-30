import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { getVercelTeamSlug } from "./team-slug"

describe("getVercelTeamSlug", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.VERCEL_TEAM_SLUG
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.VERCEL_TEAM_SLUG
    else process.env.VERCEL_TEAM_SLUG = saved
  })

  it("returns the trimmed value when set", () => {
    process.env.VERCEL_TEAM_SLUG = "  my-team  "
    expect(getVercelTeamSlug()).toBe("my-team")
  })

  it("returns null when unset", () => {
    delete process.env.VERCEL_TEAM_SLUG
    expect(getVercelTeamSlug()).toBeNull()
  })

  it("returns null when set to empty/whitespace", () => {
    process.env.VERCEL_TEAM_SLUG = "   "
    expect(getVercelTeamSlug()).toBeNull()
  })
})
