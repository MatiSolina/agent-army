/**
 * Build the meta-prompt sent to the model to draft an agent's system prompt.
 * Pure (no "use server") so it can be unit-tested and reused from the
 * server-action file.
 */
export function systemPromptInstruction(description: string): string {
  const what = description.trim() || "a helpful general-purpose assistant"
  return [
    "You are helping write the runtime system prompt for an AI agent.",
    `The user wants an agent that is: ${what}.`,
    "",
    'Write the system prompt in English, addressing the agent in the second person ("You are ...").',
    "Define who the agent is, its tone, and concise behavioral guidelines as short bullet points.",
    "Output ONLY the system prompt itself — no preamble, no markdown headings, no surrounding quotes.",
  ].join("\n")
}
