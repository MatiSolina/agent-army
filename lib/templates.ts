// Curated 1-click agent templates.
//
// A template is a fully-formed agent definition. Clicking it in the create
// dialog inserts a ready-to-use agent immediately. All values are static
// literals (no injection risk) and respect the character LIMITS so the
// resulting row is always valid.

import { DEFAULT_MODEL } from "@/lib/defaults"
import type {
  AgentSkill,
  AgentSubagent,
  AgentSchedule,
  AgentSandbox,
} from "@/lib/db/schema"

export type AgentTemplate = {
  id: string
  name: string
  description: string
  model: string
  temperature: number
  maxSteps: number
  instructions: string
  skills: AgentSkill[]
  subagents: AgentSubagent[]
  schedules: AgentSchedule[]
  sandbox: AgentSandbox
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "customer-support",
    name: "Customer Support",
    description:
      "An empathetic support agent that answers customer questions and resolves issues with care.",
    model: DEFAULT_MODEL,
    temperature: 30,
    maxSteps: 10,
    instructions: [
      "You are a customer support agent. Your job is to help customers quickly, accurately, and with genuine empathy.",
      "",
      "Guidelines:",
      "- Greet the customer warmly and acknowledge their concern before answering.",
      "- Be concise and clear. Avoid jargon; explain steps plainly.",
      "- If you do not know something, say so honestly and offer to find out or escalate.",
      "- Confirm the issue is resolved before closing, and invite any follow-up questions.",
      "- Never share internal, confidential, or speculative information.",
    ].join("\n"),
    skills: [
      {
        id: "handle-refund-request",
        name: "Handle refund request",
        description: "Steps to triage and respond to a refund request.",
        content: [
          "# Handle a refund request",
          "",
          "1. Thank the customer and confirm the order or account they are referring to.",
          "2. Ask for the reason if it is not already clear.",
          "3. Restate the relevant refund policy in plain language.",
          "4. If the request is within policy, explain the next steps and expected timeline.",
          "5. If it falls outside policy, apologize, explain why, and offer the closest available alternative.",
          "6. Confirm the customer is satisfied before closing.",
        ].join("\n"),
      },
    ],
    subagents: [],
    schedules: [],
    sandbox: { enabled: false },
  },
  {
    // Adapted from Vercel's open-source eve Content Agent template
    // (github.com/vercel-labs/eve-content-agent-template). Persona + workflow
    // only — its Notion/Slack/Blob wiring comes from MCP connections you add
    // in the editor, not from this config row.
    id: "content-agent",
    name: "Content Agent",
    description:
      "Drafts blog posts, social posts, release notes and newsletters in your team's house voice.",
    model: DEFAULT_MODEL,
    temperature: 60,
    maxSteps: 12,
    instructions: [
      "You are a content assistant. You draft content — blog posts, social posts, release notes, and newsletters — in the team's house voice, and you propose it for review before anything is published.",
      "",
      "Workflow:",
      "1. Match the voice. Load the relevant style guidance for the surface you are writing for before drafting.",
      "2. Source material. Work from the brief you are given. If a fact is unknown, delegate it to the 'researcher' subagent — never invent links, quotes, or product details.",
      "3. Self-check. Review the draft against the style guidance, then ask the 'reviewer' subagent for a fresh-eyes pass before proposing.",
      "4. Propose iteratively. Share the draft and let the writer iterate with you in short, focused messages.",
      "5. Publish only when approved. Do not publish until the writer explicitly approves; confirm before finalizing.",
      "",
      "Standards: plain language, first person where natural, no fabricated facts. When research reveals a gap, say so and ask.",
    ].join("\n"),
    skills: [
      {
        id: "house-style",
        name: "House style",
        description: "How drafts should sound across surfaces.",
        content: [
          "# House style",
          "",
          "- Lead with the point; cut throat-clearing intros.",
          "- Short sentences. One idea per sentence.",
          "- Concrete over abstract: name the thing, give the number.",
          "- Active voice, present tense where possible.",
          "- No hype words (revolutionary, game-changing, seamless) and no filler.",
          "- Match the surface: blog = structured with headings; social = one hook + one idea; release notes = what changed and why it matters.",
        ].join("\n"),
      },
    ],
    subagents: [
      {
        id: "researcher",
        name: "researcher",
        model: DEFAULT_MODEL,
        instructions:
          "You research facts for content drafts. Return verified, sourced details only. If you cannot verify something, say so explicitly — never guess or invent links, quotes, or numbers.",
      },
      {
        id: "reviewer",
        name: "reviewer",
        model: DEFAULT_MODEL,
        instructions:
          "You give a fresh-eyes review of a draft against the house style. Flag fabricated or unverifiable claims, hype words, weak openings, and anything off-voice. Be concise and specific.",
      },
    ],
    schedules: [],
    sandbox: { enabled: false },
  },
]

/**
 * Build the full insert-values object for the `agents` table from a template.
 *
 * Pure: takes the ids as arguments (no `randomUUID`, no DB access) so it can be
 * unit-tested in isolation. The server action supplies `id` and `userId`.
 */
export function agentRowFromTemplate(
  t: AgentTemplate,
  ids: { id: string; userId: string },
) {
  return {
    id: ids.id,
    userId: ids.userId,
    name: t.name,
    description: t.description,
    model: t.model,
    systemPrompt: t.instructions,
    instructions: t.instructions,
    temperature: Math.round(t.temperature),
    maxSteps: t.maxSteps,
    enabled: true,
    skills: t.skills,
    toolIds: [] as string[],
    connectionIds: [] as string[],
    subagents: t.subagents,
    schedules: t.schedules,
    sandbox: t.sandbox,
  }
}
