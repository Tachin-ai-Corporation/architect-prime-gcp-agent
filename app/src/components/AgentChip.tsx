/**
 * Derive a short human display name from an agent id/email
 * (e.g. "assistant-agent-millie@example.com" → "millie").
 * (The former <AgentChip> component was removed; this helper is still used by
 * the work views. Relocates to lib/format.ts in the primitives phase.)
 */
export function formatAgentDisplayName(name: string): string {
  if (!name) return "";
  const emailPrefix = name.split("@")[0];
  const segments = emailPrefix.split(/[-_.]/);
  const agentIdx = segments.indexOf("agent");
  if (agentIdx !== -1 && agentIdx < segments.length - 1) {
    return segments[agentIdx + 1];
  }
  if (segments.length > 1) {
    return segments[segments.length - 1];
  }
  return name;
}
