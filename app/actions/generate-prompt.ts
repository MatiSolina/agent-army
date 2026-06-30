"use server"

import { generateText } from "ai"
import { LIMITS } from "@/lib/defaults"
import { requireSessionUser } from "@/lib/session"
import { systemPromptInstruction } from "@/app/actions/generate-prompt-meta"

// Cap input + output so an authenticated caller can't drive unbounded gateway
// spend with a giant description or runaway generation.
const MAX_DESCRIPTION = 4000

// Model used to draft system prompts. A strong default; the user can edit the
// result. Plain gateway "provider/model" string (OIDC auth on Vercel,
// AI_GATEWAY_API_KEY locally).
// note: Haiku 4.5 instead of Sonnet 4.6 because Sonnet is gated behind paid
// gateway credits and the free tier returns GatewayInternalServerError. Haiku
// is good enough to draft instructions; the user edits the result anyway.
const HELPER_MODEL = "anthropic/claude-haiku-4.5"

/**
 * Draft a system prompt from a free-text description of the desired agent.
 * Returns the trimmed prompt, capped to the instructions limit.
 */
export async function generateSystemPrompt(description: string): Promise<string> {
  // Auth gate: this action burns AI Gateway credits, so it must not be callable
  // by an unauthenticated browser hitting the server-action endpoint directly.
  await requireSessionUser()
  const trimmed = description.trim()
  if (!trimmed) throw new Error("Description is required")
  const { text } = await generateText({
    model: HELPER_MODEL,
    prompt: systemPromptInstruction(trimmed.slice(0, MAX_DESCRIPTION)),
    maxOutputTokens: 2000,
  })
  return text.trim().slice(0, LIMITS.instructions)
}
