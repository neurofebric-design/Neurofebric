import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import type { ToolResult } from "../core/types.ts";

test("domain-neutral kernel smoke path writes, validates, and completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neurofebric-smoke-"));
  const filePath = path.join(root, "kernel-test.txt");
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "write", description: "Write a file" })]);
  const task = await adapter.beginTask("Create a file containing the text 'Neurofebric kernel test'.", "Create a kernel smoke-test file");
  const decision = await adapter.evaluateToolCall("write", "write", { path: filePath, content: "Neurofebric kernel test" }, { requestApproval: async () => true });
  assert.equal(decision.decision.decision, "ALLOW");
  await writeFile(filePath, "Neurofebric kernel test", "utf8");
  await adapter.observeToolResult({
    success: true,
    data: { path: filePath },
    artifacts: [{ artifactId: "artifact-1", type: "file", reference: filePath, producer: "fake-write", taskId: task.taskId, stepId: decision.task?.currentStep, createdAt: new Date().toISOString() }],
    warnings: [],
    provenance: [{ source: "fake-write", locator: filePath, artifactIds: ["artifact-1"] }],
    execution: { executionId: "execution-smoke", taskId: task.taskId, stepId: decision.task?.currentStep ?? "write", tool: "write", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: "COMPLETED", retryNumber: 0 },
  } satisfies ToolResult);
  const completed = await adapter.finishTask({ path: filePath });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(await readFile(filePath, "utf8"), "Neurofebric kernel test");
  assert.ok(adapter.recentEvents().some((event) => event.type === "TASK_COMPLETED"));
});
