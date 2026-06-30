import { describe, it, expect } from "vitest"
import { buildVercelDashboardUrls } from "./dashboard-url"

describe("buildVercelDashboardUrls", () => {
  it("builds the happy-path project / observability / logs URLs", () => {
    const result = buildVercelDashboardUrls({
      teamSlug: "lft",
      projectName: "my-agent",
    })

    expect(result.project).toBe("https://vercel.com/lft/my-agent")
    expect(result.observability).toBe(
      "https://vercel.com/lft/my-agent/observability",
    )
    expect(result.logs).toBe("https://vercel.com/lft/my-agent/logs")
  })

  it("returns absolute https vercel.com URLs for every field", () => {
    const result = buildVercelDashboardUrls({
      teamSlug: "lft",
      projectName: "my-agent",
    })

    expect(result.project).toMatch(/^https:\/\/vercel\.com\//)
    expect(result.observability).toMatch(/^https:\/\/vercel\.com\//)
    expect(result.logs).toMatch(/^https:\/\/vercel\.com\//)
  })

  it("derives observability/logs as the project URL plus a suffix", () => {
    const result = buildVercelDashboardUrls({
      teamSlug: "lft",
      projectName: "my-agent",
    })

    expect(result.observability).toBe(result.project + "/observability")
    expect(result.logs).toBe(result.project + "/logs")
  })

  it("encodes metacharacters so links cannot break out of the path", () => {
    const result = buildVercelDashboardUrls({
      teamSlug: "a b/../x",
      projectName: "a b/../x",
    })

    for (const url of [result.project, result.observability, result.logs]) {
      // No raw space; would corrupt the URL.
      expect(url).not.toContain(" ")
      // The raw "/" inside a segment must be percent-encoded so it cannot
      // create extra path segments.
      expect(url).toContain("%2F")
    }
  })

  it("returns a well-formed https URL for an empty projectName (no throw)", () => {
    const result = buildVercelDashboardUrls({
      teamSlug: "lft",
      projectName: "",
    })

    expect(result.project).toBe("https://vercel.com/lft/")
    expect(result.project).toMatch(/^https:\/\/vercel\.com\//)
    expect(result.observability).toBe(result.project + "/observability")
    expect(result.logs).toBe(result.project + "/logs")
  })
})
