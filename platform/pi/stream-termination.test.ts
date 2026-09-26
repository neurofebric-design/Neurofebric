import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";

test("stream death never completes task (F-000 regression)", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read file" })]);
  await adapter.beginTask("Task with stream termination", "Task with stream termination");

  // Simulate stream death (no content, no finish reason)
  const deadMessage = {
    role: "assistant",
    content: [],
  };

  const finished = await adapter.finishTask(deadMessage);
  assert.equal(finished.status, "FAILED", "Stream death must never transition task to COMPLETED");
  assert.equal(finished.failureReason, "Stream ended without finish_reason");
  assert.ok(adapter.recentEvents().some((e) => e.type === "TASK_FAILED"));
  assert.ok(!adapter.recentEvents().some((e) => e.type === "TASK_COMPLETED"));
});

test("clean text-only completion completes successfully", async () => {
  const adapter = new KernelAdapter();
  await adapter.beginTask("Task with text response", "Task with text response");

  const cleanMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Here is the response to your request." }],
    stopReason: "stop",
  };

  const finished = await adapter.finishTask(cleanMessage);
  assert.equal(finished.status, "COMPLETED");
  assert.ok(adapter.recentEvents().some((e) => e.type === "TASK_COMPLETED"));
});

test("tools remain available in RECOVERING; locked in COMPLETED and FAILED", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([
    toolDescriptorFromPi({ name: "read", description: "Read file" }),
    toolDescriptorFromPi({ name: "write", description: "Write file" }),
  ]);
  const task = await adapter.beginTask("Recovery and lockout test", "Recovery and lockout test");

  // Manually force RECOVERING state
  (adapter as any).task = { ...task, status: "RECOVERING" };
  
  // Precheck tool in RECOVERING should be evaluated, not denied by terminal state check
  const recoveringPrecheck = await adapter.precheckToolCall("read", "read", { path: "test.txt" });
  assert.equal(recoveringPrecheck.decision.decision, "ALLOW"); // read tool is ALLOW under default policy

  // Now transition to FAILED
  (adapter as any).task = { ...(adapter as any).task, status: "FAILED" };
  const failedPrecheck = await adapter.precheckToolCall("read", "read", { path: "test.txt" });
  assert.equal(failedPrecheck.decision.decision, "DENY");
  assert.match(failedPrecheck.decision.reason ?? "", /Task is FAILED; no further tool calls are accepted/);

  // Now transition to COMPLETED
  (adapter as any).task = { ...(adapter as any).task, status: "COMPLETED" };
  const completedPrecheck = await adapter.precheckToolCall("read", "read", { path: "test.txt" });
  assert.equal(completedPrecheck.decision.decision, "DENY");
  assert.match(completedPrecheck.decision.reason ?? "", /Task is COMPLETED; no further tool calls are accepted/);
});
