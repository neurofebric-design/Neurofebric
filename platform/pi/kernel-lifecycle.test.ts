import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";

/**
 * Regression tests for the Pi execution lifecycle contract.
 *
 * Pi's `tool_call` is a PREFLIGHT hook and may fire several times for one
 * assistant message before anything actually runs. Only
 * `tool_execution_start` / `tool_execution_end` describe real execution.
 */

const READ_TOOLS = ["read", "grep", "find", "ls"].map((name) => toolDescriptorFromPi({ name, description: name }));

async function newAdapter(request = "inspect the project") {
  const adapter = new KernelAdapter();
  adapter.registerTools(READ_TOOLS);
  adapter.registerTools([toolDescriptorFromPi({ name: "write", description: "write" })]);
  await adapter.beginTask(request, request);
  return adapter;
}

const statusOf = (adapter: KernelAdapter) => adapter.currentTask!.status;
const types = (adapter: KernelAdapter) => adapter.recentEvents(500).map((e) => e.type);

// A. One tool: preflight -> execution_start -> EXECUTING -> execution_end -> COMPLETED
test("A. one tool runs precheck, execution_start, execution_end, then completes", async () => {
  const adapter = await newAdapter();

  await adapter.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "call-1");
  assert.equal(statusOf(adapter), "PLANNING", "preflight must not advance the task");

  const bound = await adapter.beginToolExecution("call-1", "read", { path: "README.md" });
  assert.ok(bound, "execution must be bound to the task");
  assert.equal(statusOf(adapter), "EXECUTING");

  const validation = await adapter.recordToolResult("call-1", "read", { content: "ok" }, false);
  assert.equal(validation.status, "VALID");
  assert.equal(statusOf(adapter), "VALIDATING");

  const completed = await adapter.finishTask({ answer: "done" });
  assert.equal(completed.status, "COMPLETED");
  assert.ok(types(adapter).includes("TASK_COMPLETED"));

  // The real lifecycle order, with no preflight mutation in it.
  const order = types(adapter).filter((t) => ["TOOL_EXECUTION_STARTED", "TOOL_COMPLETED", "VALIDATION_COMPLETED", "TASK_COMPLETED"].includes(t));
  assert.deepEqual(order, ["TOOL_EXECUTION_STARTED", "TOOL_COMPLETED", "VALIDATION_COMPLETED", "TASK_COMPLETED"]);
});

// A2. Preflight alone never mutates lifecycle state, no matter how many fire.
test("A2. repeated preflight for the same turn never moves the task into EXECUTING", async () => {
  const adapter = await newAdapter();
  for (const id of ["c1", "c2", "c3"]) {
    await adapter.precheckToolCall("read", "execute", { path: id }, undefined, id);
  }
  assert.equal(statusOf(adapter), "PLANNING");
  assert.equal(adapter.currentPlan, undefined, "preflight must not create a plan");
  assert.equal(adapter.currentTask!.currentStep, undefined, "preflight must not set currentStep");
  assert.equal(adapter.activeExecution("c1"), undefined);
  assert.equal(adapter.activeExecution("c2"), undefined);
});

// B. Two tools from one assistant turn, Pi's real parallel ordering:
//    start1, start2 (both before either finishes), end1, end2.
test("B. two tools from one assistant message each get their own lifecycle", async () => {
  const adapter = await newAdapter();

  await adapter.precheckToolCall("read", "execute", { path: "a" }, undefined, "c1");
  await adapter.precheckToolCall("grep", "execute", { pattern: "x" }, undefined, "c2");
  assert.equal(statusOf(adapter), "PLANNING", "both preflights must be non-mutating");

  const first = await adapter.beginToolExecution("c1", "read");
  assert.ok(first);
  assert.equal(statusOf(adapter), "EXECUTING");

  const second = await adapter.beginToolExecution("c2", "grep");
  assert.ok(second, "a concurrent sibling execution must also be bound");
  assert.equal(statusOf(adapter), "EXECUTING");
  assert.notEqual(first!.stepId, second!.stepId, "each execution needs its own step");

  // First result settles while its sibling is still in flight: task stays EXECUTING.
  await adapter.recordToolResult("c1", "read", { content: "a" }, false);
  assert.equal(statusOf(adapter), "EXECUTING", "must not leave EXECUTING while a sibling runs");
  assert.equal(adapter.activeExecution("c1"), undefined);
  assert.ok(adapter.activeExecution("c2"));

  // Last result drives the real observation and validation.
  await adapter.recordToolResult("c2", "grep", { matches: [] }, false);
  assert.equal(statusOf(adapter), "VALIDATING");
  assert.equal(adapter.activeExecution("c2"), undefined);

  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
  assert.equal(adapter.recentEvents(500).filter((e) => e.type === "TOOL_COMPLETED").length, 2);
});

// B2. Same two tools, but Pi executed them sequentially.
test("B2. two sequential tools each get a full plan/execute/validate lifecycle", async () => {
  const adapter = await newAdapter();
  const stepIds: string[] = [];

  for (const [id, tool] of [["c1", "read"], ["c2", "ls"]] as const) {
    await adapter.precheckToolCall(tool, "execute", {}, undefined, id);
    const bound = await adapter.beginToolExecution(id, tool);
    assert.ok(bound, `execution ${id} must bind`);
    assert.equal(statusOf(adapter), "EXECUTING");
    stepIds.push(bound!.stepId);
    await adapter.recordToolResult(id, tool, { ok: true }, false);
    assert.equal(statusOf(adapter), "VALIDATING", `tool ${id} must end validated`);
  }

  assert.equal(new Set(stepIds).size, 2, "each sequential tool needs its own step");
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
  assert.equal(adapter.recentEvents(500).filter((e) => e.type === "PLAN_VALIDATED").length, 2);
});

// C. Three sequential tools.
test("C. three sequential tools each traverse the full lifecycle", async () => {
  const adapter = await newAdapter();
  const tools = ["read", "grep", "ls"] as const;
  const seen: string[] = [];

  for (const [index, tool] of tools.entries()) {
    const id = `c${index}`;
    await adapter.precheckToolCall(tool, "execute", {}, undefined, id);
    const bound = await adapter.beginToolExecution(id, tool);
    assert.ok(bound, `execution ${id} must bind`);
    assert.equal(statusOf(adapter), "EXECUTING");
    await adapter.recordToolResult(id, tool, { ok: true }, false);
    assert.equal(statusOf(adapter), "VALIDATING");
    seen.push(tool);
  }

  assert.deepEqual(seen, ["read", "grep", "ls"]);
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
  assert.equal(adapter.recentEvents(500).filter((e) => e.type === "TOOL_EXECUTION_STARTED").length, 3);
  assert.equal(adapter.recentEvents(500).filter((e) => e.type === "TASK_COMPLETED").length, 1);
});

// D. Policy denial must not create an execution.
test("D. a denied preflight creates no execution and no fake success", async () => {
  const adapter = await newAdapter();
  const decision = await adapter.precheckToolCall("write", "execute", { path: "x" }, { requestApproval: async () => false }, "call-w");
  assert.equal(decision.decision.decision, "DENY");
  assert.equal(statusOf(adapter), "PLANNING", "a denial must not fail or advance the task");
  assert.equal(adapter.currentPlan, undefined);

  // Pi can still emit an execution_start around a blocked preflight.
  const bound = await adapter.beginToolExecution("call-w", "write");
  assert.equal(bound, undefined, "a denied call must never be bound to the task");
  assert.equal(statusOf(adapter), "PLANNING");
  assert.ok(types(adapter).includes("APPROVAL_DENIED"));
  assert.ok(types(adapter).includes("TOOL_EXECUTION_IGNORED"));

  // And any result for it must not be observed as a successful execution.
  const validation = await adapter.recordToolResult("call-w", "write", { written: true }, false);
  assert.equal(validation.status, "INCONCLUSIVE");
  assert.equal(adapter.currentTask!.validationResults.length, 0);
  assert.equal(statusOf(adapter), "PLANNING");
});

// D2. A denial must not stop a later, permitted tool in the same turn.
test("D2. a denied call does not poison the rest of the turn", async () => {
  const adapter = await newAdapter();
  await adapter.precheckToolCall("write", "execute", {}, { requestApproval: async () => false }, "bad");
  await adapter.precheckToolCall("read", "execute", {}, undefined, "good");
  assert.equal(statusOf(adapter), "PLANNING");

  const bound = await adapter.beginToolExecution("good", "read");
  assert.ok(bound);
  assert.equal(statusOf(adapter), "EXECUTING");
  await adapter.recordToolResult("good", "read", { ok: true }, false);
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
});

// E. Approval requirement.
test("E. approval granted permits the execution and emits APPROVAL_REQUIRED", async () => {
  const adapter = await newAdapter();
  const decision = await adapter.precheckToolCall("write", "execute", {}, { requestApproval: async () => true }, "call-a");
  assert.equal(decision.decision.decision, "ALLOW");
  assert.equal(statusOf(adapter), "PLANNING");
  assert.ok(types(adapter).includes("APPROVAL_REQUIRED"));

  assert.ok(await adapter.beginToolExecution("call-a", "write"));
  assert.equal(statusOf(adapter), "EXECUTING");
  await adapter.recordToolResult("call-a", "write", { ok: true }, false);
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
});

// F. Duplicate execution_start.
test("F. duplicate execution_start is ignored", async () => {
  const adapter = await newAdapter();
  const first = await adapter.beginToolExecution("call-1", "read");
  const statusAfterFirst = statusOf(adapter);
  const stepAfterFirst = adapter.currentTask!.currentStep;

  const second = await adapter.beginToolExecution("call-1", "read");
  assert.equal(second, undefined, "a repeated execution_start must not re-bind");
  assert.equal(statusOf(adapter), statusAfterFirst);
  assert.equal(adapter.currentTask!.currentStep, stepAfterFirst);
  assert.equal(adapter.recentEvents(500).filter((e) => e.type === "TOOL_EXECUTION_STARTED").length, 1);

  await adapter.recordToolResult("call-1", "read", { ok: true }, false);
  assert.equal(statusOf(adapter), "VALIDATING");
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
});

// G. Duplicate execution_end.
test("G. duplicate execution_end is ignored and cannot re-validate", async () => {
  const adapter = await newAdapter();
  await adapter.beginToolExecution("call-1", "read");
  const first = await adapter.recordToolResult("call-1", "read", { ok: true }, false);
  assert.equal(first.status, "VALID");
  assert.equal(statusOf(adapter), "VALIDATING");

  const duplicate = await adapter.recordToolResult("call-1", "read", { ok: true }, false);
  assert.equal(duplicate.status, "INCONCLUSIVE", "a duplicate result must be ignored");
  assert.equal(adapter.currentTask!.validationResults.length, 1, "no second validation may be recorded");
  assert.equal(statusOf(adapter), "VALIDATING", "no VALIDATING -> OBSERVING");
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
});

// H. Late execution_end.
test("H. late execution_end cannot resurrect a completed task", async () => {
  const adapter = await newAdapter();
  await adapter.beginToolExecution("call-1", "read");
  await adapter.recordToolResult("call-1", "read", { ok: true }, false);
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");

  const late = await adapter.recordToolResult("call-1", "read", { ok: true }, false);
  assert.equal(late.status, "INCONCLUSIVE");
  assert.equal(statusOf(adapter), "COMPLETED");
  assert.equal(adapter.currentTask!.validationResults.length, 1);
});

test("H2. a result for an execution that never started is ignored", async () => {
  const adapter = await newAdapter();
  const orphan = await adapter.recordToolResult("never-started", "read", { ok: true }, false);
  assert.equal(orphan.status, "INCONCLUSIVE");
  assert.equal(statusOf(adapter), "PLANNING");
  assert.equal(adapter.currentTask!.validationResults.length, 0);
});

// I. Tool failure and recovery.
test("I. a failed tool drives recovery and the task can plan again", async () => {
  const adapter = await newAdapter();
  await adapter.beginToolExecution("call-1", "read");
  const validation = await adapter.recordToolResult("call-1", "read", undefined, true);
  assert.equal(validation.status, "INVALID");
  assert.ok(types(adapter).includes("TOOL_FAILED"));
  assert.ok(types(adapter).includes("RECOVERY_STARTED"));
  assert.equal(statusOf(adapter), "PLANNING", "recovery must land on a real planning state");

  // The retry plans and runs for real.
  const bound = await adapter.beginToolExecution("call-2", "read");
  assert.ok(bound, "recovery must allow a new execution");
  assert.equal(statusOf(adapter), "EXECUTING");
  await adapter.recordToolResult("call-2", "read", { ok: true }, false);
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");
});

test("I2. recovery refuses execution while the task is RECOVERING", async () => {
  const adapter = await newAdapter();
  await adapter.beginToolExecution("call-1", "read");
  await adapter.recordToolResult("call-1", "read", undefined, true);

  // Force the recovering state and confirm no execution is admitted.
  const task = adapter.currentTask!;
  (adapter as unknown as { task: { status: string } }).task = { ...task, status: "RECOVERING" };
  const bound = await adapter.beginToolExecution("call-x", "read");
  assert.equal(bound, undefined);
  assert.equal(statusOf(adapter), "RECOVERING");
});

test("I3. terminal states refuse new executions", async () => {
  for (const status of ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ESCALATED", "REPLANNING"] as const) {
    const adapter = await newAdapter();
    (adapter as unknown as { task: { status: string } }).task = { ...adapter.currentTask!, status };
    const bound = await adapter.beginToolExecution("call-x", "read");
    assert.equal(bound, undefined, `execution must be refused from ${status}`);
    assert.equal(statusOf(adapter), status);
  }
});

// J. No-tool task.
test("J. a task that never calls a tool still completes via a real response lifecycle", async () => {
  const adapter = await newAdapter("just answer");
  assert.equal(adapter.toolExecutionCount, undefined ?? 0);
  const completed = await adapter.finishTask({ text: "hello" });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.currentPlan?.steps[0].stepId, "response");
  assert.ok(types(adapter).includes("RESPONSE_OBSERVED"));
  assert.ok(types(adapter).includes("TASK_COMPLETED"));
});

// Requirement 7: the VALIDATING -> PLANNING boundary is what lets a real next
// tool start, and it is a genuine state-machine edge, not a preflight workaround.
test("K. VALIDATING -> PLANNING is the real boundary between two executed tools", async () => {
  const adapter = await newAdapter();
  await adapter.beginToolExecution("c1", "read");
  await adapter.recordToolResult("c1", "read", { ok: true }, false);
  assert.equal(statusOf(adapter), "VALIDATING");

  const planValidationsBefore = adapter.recentEvents(500).filter((e) => e.type === "PLAN_VALIDATED").length;
  assert.ok(await adapter.beginToolExecution("c2", "ls"), "the next real execution must be admitted");
  assert.equal(statusOf(adapter), "EXECUTING");
  assert.equal(
    adapter.recentEvents(500).filter((e) => e.type === "PLAN_VALIDATED").length,
    planValidationsBefore + 1,
    "the second tool must re-validate its own plan",
  );
});

test("K2. an INVALID validation does not admit a new execution", async () => {
  const adapter = await newAdapter();
  await adapter.beginToolExecution("c1", "read");
  await adapter.recordToolResult("c1", "read", undefined, true);
  // Recovery landed on PLANNING with an INVALID last validation.
  (adapter as unknown as { task: { status: string } }).task = { ...adapter.currentTask!, status: "VALIDATING" };
  const bound = await adapter.beginToolExecution("c2", "ls");
  assert.equal(bound, undefined);
});
