export function buildWorkflowGuidance(skills) {
  const catalog = skills.length > 0
    ? skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")
    : "- No project skills are currently available.";

  return [
    "Platform workflow:",
    "- Understand the user's task and identify the evidence needed.",
    "- Make a short plan before acting when the task has multiple steps.",
    "- Select a relevant project skill from the available skill descriptions; do not assume a domain-specific skill.",
    "- Use the smallest deterministic tool operation that answers the question.",
    "- Validate findings against source evidence and state limitations.",
    "- Return a concise result with evidence, risks, and next steps.",
    "",
    "Available project skills:",
    catalog,
  ].join("\n");
}

export function summarizeTrace(entries) {
  return entries.slice(-10).map((entry) => `${entry.timestamp} ${entry.type}`).join("\n");
}
