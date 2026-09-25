import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import type { ToolResult } from "../core/types.ts";

function result(taskId: string, stepId: string, success = true): ToolResult {
  const now = new Date().toISOString();
  return {
    success,
    data: success ? { content: "ok" } : undefined,
    artifacts: [],
    warnings: [],
    error: success ? undefined : { category: "TOOL_ERROR", message: "failed", retryable: false },
    provenance: [{ source: "fake-tool", artifactIds: [] }],
    execution: {
      executionId: "execution-1",
      taskId,
      stepId,
      tool: "read",
      startedAt: now,
      endedAt: now,
      status: success ? "COMPLETED" : "FAILED",
      retryNumber: 0,
    },
  };
}

test("live adapter creates a task, plans a Pi tool call, and completes after validation", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read a file" })]);
  const task = await adapter.beginTask("Read the project file", "Read the project file");
  const planned = await adapter.evaluateToolCall("read", "read", { path: "README.md" });
  assert.equal(planned.decision.decision, "ALLOW");
  assert.equal(planned.task?.status, "EXECUTING");
  const validation = await adapter.observeToolResult(result(task.taskId, adapter.currentTask?.currentStep ?? "unknown"));
  assert.equal(validation.status, "VALID");
  const completed = await adapter.finishTask({ answer: "done" });
  assert.equal(completed.status, "COMPLETED");
  assert.ok(adapter.recentEvents().some((event) => event.type === "TASK_COMPLETED"));
});

test("live adapter rejects missing tools before Pi execution", async () => {
  const adapter = new KernelAdapter();
  await adapter.beginTask("Use missing tool", "Use missing tool");
  await assert.rejects(() => adapter.evaluateToolCall("missing", "execute", {}), /Unknown tool/);
});

test("approval denial becomes a failed task and emits policy events", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "write", description: "Write a file" })]);
  const task = await adapter.beginTask("Write a file", "Write a file");
  const decision = await adapter.evaluateToolCall("write", "write", { path: "x", content: "x" }, {
    requestApproval: async () => false,
  });
  assert.equal(decision.decision.decision, "DENY");
  assert.equal(adapter.currentTask?.taskId, task.taskId);
  assert.equal(adapter.currentTask?.status, "FAILED");
  assert.ok(adapter.recentEvents().some((event) => event.type === "APPROVAL_DENIED"));
});

test("tool failure enters recovery and emits a failure event", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read a file" })]);
  const task = await adapter.beginTask("Read a file", "Read a file");
  await adapter.evaluateToolCall("read", "read", { path: "x" });
  const validation = await adapter.observeToolResult(result(task.taskId, adapter.currentTask?.currentStep ?? "unknown", false), new Error("read failed"));
  assert.equal(validation.status, "INVALID");
  assert.equal(adapter.currentTask?.status, "PLANNING");
  assert.equal(adapter.currentTask?.replanCount, 1);
  assert.ok(adapter.recentEvents().some((event) => event.type === "RECOVERY_STARTED"));
});
