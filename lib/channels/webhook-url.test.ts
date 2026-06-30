import { describe, it, expect } from "vitest"
import {
  kapsoWebhookUrl,
  telegramWebhookUrl,
  discordInteractionsEndpointUrl,
} from "./webhook-url"

describe("kapsoWebhookUrl", () => {
  it("builds the deployed-agent webhook URL from a deployed agent", () => {
    expect(
      kapsoWebhookUrl({
        deploymentUrl: "https://my-agent.vercel.app",
        deploymentStatus: "deployed",
      }),
    ).toEqual({
      ready: true,
      url: "https://my-agent.vercel.app/kapso/webhook",
    })
  })

  it("strips a trailing slash on the deployment URL before appending the path", () => {
    expect(
      kapsoWebhookUrl({
        deploymentUrl: "https://my-agent.vercel.app/",
        deploymentStatus: "deployed",
      }).url,
    ).toBe("https://my-agent.vercel.app/kapso/webhook")
  })

  it("is not ready when no agent is assigned (null)", () => {
    expect(kapsoWebhookUrl(null)).toEqual({ ready: false, url: null })
  })

  it("is not ready when the agent has no deployment URL", () => {
    expect(
      kapsoWebhookUrl({ deploymentUrl: null, deploymentStatus: "none" }),
    ).toEqual({ ready: false, url: null })
  })

  it("is not ready when the agent is not in the deployed state", () => {
    expect(
      kapsoWebhookUrl({
        deploymentUrl: "https://my-agent.vercel.app",
        deploymentStatus: "deploying",
      }),
    ).toEqual({ ready: false, url: null })
  })
})

describe("telegramWebhookUrl", () => {
  it("is not ready when no agent is assigned (null)", () => {
    expect(telegramWebhookUrl(null)).toEqual({ ready: false, url: null })
  })

  it("is not ready when the agent is not deployed", () => {
    expect(
      telegramWebhookUrl({
        deploymentUrl: "https://my-agent.vercel.app",
        deploymentStatus: "deploying",
      }),
    ).toEqual({ ready: false, url: null })
  })

  it("builds the eve-prefixed /eve/v1/telegram URL for a deployed agent", () => {
    expect(
      telegramWebhookUrl({
        deploymentUrl: "https://my-agent.vercel.app",
        deploymentStatus: "deployed",
      }),
    ).toEqual({
      ready: true,
      url: "https://my-agent.vercel.app/eve/v1/telegram",
    })
  })

  it("strips trailing slashes on the base before appending the eve path", () => {
    expect(
      telegramWebhookUrl({
        deploymentUrl: "https://my-agent.vercel.app///",
        deploymentStatus: "deployed",
      }).url,
    ).toBe("https://my-agent.vercel.app/eve/v1/telegram")
  })

  it("uses the first-class eve prefix, not a literal /kapso/webhook path", () => {
    const url = telegramWebhookUrl({
      deploymentUrl: "https://my-agent.vercel.app",
      deploymentStatus: "deployed",
    }).url
    expect(url).toContain("/eve/v1/telegram")
    expect(url).not.toContain("/kapso/webhook")
  })
})

describe("discordInteractionsEndpointUrl", () => {
  it("is not ready when no agent is assigned (null)", () => {
    expect(discordInteractionsEndpointUrl(null)).toEqual({
      ready: false,
      url: null,
    })
  })

  it("is not ready when the agent is not deployed", () => {
    expect(
      discordInteractionsEndpointUrl({
        deploymentUrl: "https://my-agent.vercel.app",
        deploymentStatus: "deploying",
      }),
    ).toEqual({ ready: false, url: null })
  })

  it("builds the eve-prefixed /eve/v1/discord URL for a deployed agent", () => {
    expect(
      discordInteractionsEndpointUrl({
        deploymentUrl: "https://my-agent.vercel.app",
        deploymentStatus: "deployed",
      }),
    ).toEqual({
      ready: true,
      url: "https://my-agent.vercel.app/eve/v1/discord",
    })
  })

  it("strips trailing slashes on the base before appending the eve path", () => {
    expect(
      discordInteractionsEndpointUrl({
        deploymentUrl: "https://my-agent.vercel.app///",
        deploymentStatus: "deployed",
      }).url,
    ).toBe("https://my-agent.vercel.app/eve/v1/discord")
  })

  it("uses the first-class eve prefix, not a literal /kapso/webhook path", () => {
    const url = discordInteractionsEndpointUrl({
      deploymentUrl: "https://my-agent.vercel.app",
      deploymentStatus: "deployed",
    }).url
    expect(url).toContain("/eve/v1/discord")
    expect(url).not.toContain("/kapso/webhook")
  })
})
