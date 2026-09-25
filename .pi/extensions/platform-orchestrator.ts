import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "../../platform/skill-registry.mjs";
import { KernelAdapter } from "../../platform/pi/kernel-adapter.ts";
import { PiApprovalProvider } from "../../platform/pi/approval.ts";
import { toolDescriptorFromPi } from "../../platform/pi/tool-adapter.ts";

type TraceEntry = {
  type: string;
  timestamp: string;
  details?: Record<string, unknown>;
};

const trace: TraceEntry[] = [];
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

export default function platformOrchestrator(pi: ExtensionAPI): void {
  persistTrace = (entry) => pi.appendEntry("platform-trace", entry);
  // Pi remains the only agent loop; this adapter only translates lifecycle events into kernel state.
  const kernel = new KernelAdapter();

  kernel.events.subscribe((event) => record(event.type, event.payload));

  pi.on("resources_discover", (event) => ({
    skillPaths: [path.join(event.cwd, "skills")],
  }));

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const tools = pi.getAllTools().map((tool) => toolDescriptorFromPi({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    kernel.registerTools(tools);
    const skills = await discoverSkills(path.join(ctx.cwd, "skills"));
    kernel.setSkills(skills.map((skill) => ({
      name: skill.name,
      version: "0.0.0",
      description: skill.description,
      capabilities: [],
      supportedInputs: [],
      supportedOutputs: [],
      requiredTools: [],
      optionalTools: [],
      dependencies: [],
      constraints: [],
      riskLevel: "READ_ONLY" as const,
      examples: [],
    })));
    record("session_start", { toolCount: tools.length, skillCount: skills.length });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // A task is created per user turn. Pi still owns the conversation and model call.
    const task = await kernel.beginTask(event.prompt, event.prompt, { cwd: ctx.cwd });
    record("task_received", { taskId: task.taskId, promptPreview: redactPreview(event.prompt) });
  });

  // `tool_call` is a PREFLIGHT hook. Several can fire for one assistant message
  // before any tool actually runs, so this stage performs policy evaluation
  // ONLY and must never mutate the kernel task lifecycle.
  pi.on("tool_call", async (event, ctx) => {
    if (!kernel.currentTask) return undefined;
    const approval = new PiApprovalProvider(ctx.hasUI, async (prompt) => {
      return (await ctx.ui.confirm("Neurofebric policy approval", prompt)) === true;
    });
    const { decision } = await kernel.precheckToolCall(event.toolName, "execute", event.input, approval, event.toolCallId);
    record("policy_decision", { tool: event.toolName, toolCallId: event.toolCallId, decision, taskStatus: kernel.currentTask.status });
    if (decision.decision !== "ALLOW") {
      // `decision.reason` is present on both DENY and REQUIRE_APPROVAL.
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });

  // `tool_execution_start` is the real execution. This is where the tool call is
  // bound to the task, a plan/step is created, the plan is validated and the task
  // moves PLANNING -> PLAN_VALIDATION -> EXECUTING.
  pi.on("tool_execution_start", async (event) => {
    if (!kernel.currentTask) return;
    const bound = await kernel.beginToolExecution(event.toolCallId, event.toolName, { toolCallId: event.toolCallId });
    record("tool_execution_start", {
      toolCallId: event.toolCallId,
      tool: event.toolName,
      bound: Boolean(bound),
      taskStatus: kernel.currentTask.status,
    });
  });

  // `tool_execution_end` is observation and validation of a real bound execution.
  pi.on("tool_execution_end", async (event) => {
    if (!kernel.currentTask) return;
    // Pi owns the actual result shape; the kernel normalizes it against the
    // bound execution identity so task/step correlation cannot drift.
    await kernel.recordToolResult(event.toolCallId, event.toolName, event.result, event.isError);
    record("tool_execution_end", { toolCallId: event.toolCallId, tool: event.toolName, isError: event.isError, taskStatus: kernel.currentTask.status });
  });

  pi.on("agent_end", async (event) => {
    if (!kernel.currentTask) return;
    const lastMessage = [...event.messages].reverse().find((message) => message.role === "assistant");
    await kernel.finishTask(lastMessage);
    record("agent_end", { taskId: kernel.currentTask.taskId, status: kernel.currentTask.status });
  });

  pi.registerCommand("platform", {
    description: "Show Neurofebric kernel status and recent trace",
    handler: async (_args, ctx) => {
      const task = kernel.currentTask;
      const events = kernel.recentEvents().slice(-10).map((event) => `${event.timestamp} ${event.type}`).join("\n");
      const status = task ? `Task ${task.taskId}: ${task.status}` : "No active task";
      ctx.ui.notify(`${status}\n\nRecent events:\n${events || "No events yet"}`, "info");
    },
  });
}
