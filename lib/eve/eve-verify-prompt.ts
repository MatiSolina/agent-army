/**
 * Pure builder for the gated-eve-bump preview-test FAILURE handoff prompt.
 *
 * When a per-agent preview-test of a gated eve bump fails (build / deploy / ping
 * error), the dashboard shows a copy-paste prompt the operator can hand to a
 * coding agent. The fix lives UPSTREAM in this repo's generator (`generate.ts` /
 * `project.ts`), not in each agent instance — instances are re-generated from the
 * generator, so the prompt points there.
 *
 * The prompt text is NEVER stored: it is rendered on demand from the agent name,
 * the from/to versions and the raw `eveVerifyError`, so improving the copy never
 * leaves stale prompts cached in the DB. The `error` is the already-sanitized
 * value persisted in `agents.eveVerifyError` (no secrets).
 */
export function buildEveVerifyHandoffPrompt(input: {
  agentName: string
  fromVersion: string
  toVersion: string
  error: string | null | undefined
}): string {
  const { agentName, fromVersion, toVersion } = input
  const error = input.error?.trim() ? input.error.trim() : "(no error captured)"
  return [
    `Eve ${fromVersion}→${toVersion} breaks my agent "${agentName}". Error from the pinned preview deploy:`,
    error,
    "Generator to review: lib/eve/generate.ts, lib/eve/project.ts.",
    `Fix the generator so it compiles against eve ${toVersion} and re-deploy.`,
  ].join("\n")
}
