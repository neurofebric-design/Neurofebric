import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills, formatSkillCatalog } from "../../platform/skill-registry.mjs";
import { buildWorkflowGuidance, summarizeTrace } from "../../platform/orchestration.mjs";

type TraceEntry = {
  type: string;
  timestamp: string;
  details?: Record<string, unknown>;
};

const trace: TraceEntry[] = [];
let skillCatalog: Awaited<ReturnType<typeof discoverSkills>> = [];
let persistTrace: ((entry: TraceEntry) => void) | undefined;

function redactPreview(value: string): string {
  return value
    .replace(/\b(api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 160);
}

function record(type: string, details?: Record<string, unknown>): void {
  const entry: TraceEntry = { type, timestamp: new Date().toISOString(), details };
  trace.push(entry);
  if (trace.length > 100) trace.shift();
  persistTrace?.(entry);
}

async function refreshSkills(ctx: ExtensionContext): Promise<void> {
  skillCatalog = await discoverSkills(path.join(ctx.cwd, "skills"));
  record("skills_discovered", {
    count: skillCatalog.length,
    names: skillCatalog.map((skill) => skill.name),
  });
}

function isDestructiveBash(command: string): boolean {
  return /\brm\s+(-rf?|--recursive)\b|\bsudo\b|\bchmod\b|\bchown\b/i.test(command);
}

export default function platformOrchestrator(pi: ExtensionAPI): void {
  persistTrace = (entry) => pi.appendEntry("platform-trace", entry);

  pi.on("resources_discover", (event) => ({
    skillPaths: [path.join(event.cwd, "skills")],
  }));

  pi.on("session_start", async (_event, ctx) => {
    await refreshSkills(ctx);
    record("session_start");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (skillCatalog.length === 0) await refreshSkills(ctx);
    record("task_received", {
      promptPreview: redactPreview(event.prompt),
      cwd: ctx.cwd,
    });
    event.systemPromptOptions.sections.tool_guidance = buildWorkflowGuidance(skillCatalog);
  });

  pi.on("tool_call", async (event, ctx) => {
    record("tool_call", { tool: event.toolName });

    if (event.toolName !== "bash") return undefined;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (!isDestructiveBash(command)) return undefined;

    if (!ctx.hasUI) {
      record("permission_denied", { tool: event.toolName, reason: "no_ui" });
      return { block: true, reason: "Destructive shell command blocked because no interactive approval is available" };
    }

    const choice = await ctx.ui.select(
      `Sensitive shell command requires approval:\n\n${command}`,
      ["Allow", "Block"],
    );
    if (choice !== "Allow") {
      record("permission_denied", { tool: event.toolName, reason: "user_blocked" });
      return { block: true, reason: "Blocked by user" };
    }

    record("permission_granted", { tool: event.toolName });
    return undefined;
  });

  pi.on("agent_end", async () => {
    record("agent_end");
  });

  pi.registerCommand("platform", {
    description: "Show discovered platform skills and recent orchestration trace",
    handler: async (_args, ctx) => {
      if (skillCatalog.length === 0) await refreshSkills(ctx);
      const skills = skillCatalog.length > 0 ? formatSkillCatalog(skillCatalog) : "No project skills discovered.";
      const recentTrace = summarizeTrace(trace);
      ctx.ui.notify(`Platform skills:\n${skills}\n\nRecent trace:\n${recentTrace}`, "info");
    },
  });
}
