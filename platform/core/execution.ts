import { randomUUID } from "node:crypto";
import { CoreError } from "./errors.ts";
import type { ExecutionRecord, Task, ToolDescriptor, ToolResult } from "./types.ts";

export interface ToolRunner<T = unknown> {
  run(tool: ToolDescriptor, input: unknown, signal?: AbortSignal): Promise<{ data: T; artifacts?: ToolResult["artifacts"]; warnings?: string[]; metadata?: Record<string, unknown>; provenance?: ToolResult["provenance"] }>;
}

export async function executeTool<T>(options: {
  task: Task;
  stepId: string;
  tool: ToolDescriptor;
  input: unknown;
  runner: ToolRunner<T>;
  retryNumber?: number;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<ToolResult<T>> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const execution: ExecutionRecord = {
    executionId: randomUUID(),
    taskId: options.task.taskId,
    stepId: options.stepId,
    tool: options.tool.name,
    startedAt,
    status: "STARTED",
    retryNumber: options.retryNumber ?? 0,
    inputMetadata: { inputType: typeof options.input },
  };
  try {
    if (options.signal?.aborted) throw new CoreError("TOOL_ERROR", "Tool execution cancelled", { taskId: options.task.taskId, stepId: options.stepId });
    const result = await options.runner.run(options.tool, options.input, options.signal);
    const endedAt = now().toISOString();
    const completed: ExecutionRecord = {
      ...execution,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      status: "COMPLETED",
      outputMetadata: result.metadata,
    };
    return {
      success: true,
      data: result.data,
      metadata: result.metadata,
      artifacts: result.artifacts ?? [],
      warnings: result.warnings ?? [],
      provenance: result.provenance ?? [],
      execution: completed,
    };
  } catch (error) {
    const endedAt = now().toISOString();
    const coreError = error instanceof CoreError ? error : new CoreError("TOOL_ERROR", error instanceof Error ? error.message : String(error), { cause: error, taskId: options.task.taskId, stepId: options.stepId });
    const failed: ExecutionRecord = {
      ...execution,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      status: coreError.message === "Tool execution cancelled" ? "CANCELLED" : "FAILED",
      error: { category: coreError.category, message: coreError.message, retryable: coreError.retryable },
    };
    throw Object.assign(coreError, { execution: failed });
  }
}
