// Centralized default values and limits for agent/channel configuration.
// Keeping these out of components avoids hardcoded magic strings in the UI.

import { DEFAULT_MODEL } from "@/lib/models"

/** Default system prompt for a brand-new agent (shown in the create dialog). */
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful and friendly assistant."

/** Default temperature (stored 0-100; divide by 100 at use site). */
export const DEFAULT_TEMPERATURE = 70

/** Default runtime system prompt for a new agent. */
export const DEFAULT_INSTRUCTIONS =
  "You are a helpful assistant. Respond clearly and concisely."

/** Default JSON Schema scaffold for a new tool's input. */
export const DEFAULT_TOOL_INPUT_SCHEMA = '{\n  "type": "object",\n  "properties": {}\n}'

/** Default cron expression for a new schedule (every day at 9am). */
export const DEFAULT_CRON = "0 9 * * *"

/** Default sandbox runtime / timeout. */
export const DEFAULT_SANDBOX_RUNTIME = "node22"
export const DEFAULT_SANDBOX_TIMEOUT_MS = 30000

export { DEFAULT_MODEL }

// ----- character limits (used for inline counters + maxLength) -----
export const LIMITS = {
  agentName: 80,
  agentDescription: 160,
  instructions: 8000,
  systemPrompt: 4000,
  skillContent: 8000,
  toolSchema: 4000,
  subagentInstructions: 4000,
  schedulePrompt: 2000,
  sandboxSetup: 2000,
} as const
