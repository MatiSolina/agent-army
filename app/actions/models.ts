"use server"

import { gateway, generateText } from "ai"
import { mapGatewayModels, type Model } from "@/lib/models"
import { requireSessionUser } from "@/lib/session"

// Memoized for the lifetime of the server process: the full gateway model list
// changes rarely and the picker can tolerate a stale-until-restart list.
// Failures are NOT cached, so a transient gateway error retries next call.
let cache: Model[] | null = null

/**
 * All language models available through the AI Gateway, mapped to our `Model`
 * shape. Returns [] if the gateway is unreachable so the picker degrades to the
 * suggested shortlist.
 */
export async function getGatewayModels(): Promise<Model[]> {
  await requireSessionUser()
  if (cache) return cache
  try {
    const { models } = await gateway.getAvailableModels()
    const mapped = mapGatewayModels(models)
    cache = mapped
    return mapped
  } catch {
    return []
  }
}

// A frontier model the free tier hard-blocks ("do not have access"). Probing it
// tells us whether THIS team has paid AI credits.
const PAID_PROBE_MODEL = "anthropic/claude-sonnet-4.6"
let creditsCache: boolean | null = null

/**
 * Whether the team's AI Gateway has paid credits. Probes one paid-only model: a
 * "do not have access" error means the team is on the free tier (no credits), so
 * the picker disables credit-only models. Any other outcome assumes credits — we
 * never lock the picker on a transient/unknown error. Only the definitive
 * free-tier result is cached.
 */
export async function hasGatewayCredits(): Promise<boolean> {
  await requireSessionUser()
  if (creditsCache !== null) return creditsCache
  try {
    await generateText({ model: PAID_PROBE_MODEL, prompt: "hi", maxOutputTokens: 16 })
    creditsCache = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/do not have access/i.test(msg)) {
      creditsCache = false
    } else {
      return true // transient/unknown — don't lock the picker, don't cache
    }
  }
  return creditsCache
}
