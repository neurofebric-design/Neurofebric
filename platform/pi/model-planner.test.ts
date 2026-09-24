import test from "node:test";
import assert from "node:assert/strict";
import { StructuredModelPlanner } from "./model-planner.ts";
import { CoreError } from "../core/errors.ts";
import type { PlannerInput } from "../core/planner.ts";

const input: PlannerInput = {
  objective: "Read a file",
  constraints: {},
  availableSkills: [],
  availableTools: [{
    name: "read", version: "1", description: "Read", inputSchema: {}, outputSchema: {},
    capabilities: ["file.read"], permissions: ["file:read"], riskLevel: "READ_ONLY", timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 }, idempotency: "IDEMPOTENT", sideEffect: "PURE",
  }],
  observations: [],
  completedSteps: [],
  failedSteps: [],
};

test("structured planner validates model output", async () => {
  const planner = new StructuredModelPlanner({ generatePlan: async () => ({
    planId: "plan-1", objective: "Read a file", steps: [{ stepId: "read", description: "Read", tools: ["read"], dependencies: [], expectedOutput: "content", validationCriteria: ["content exists"] }],
  }) });
  const plan = await planner.createPlan(input);
  assert.equal(plan.steps[0]?.stepId, "read");
});

test("structured planner rejects malformed model output", async () => {
  const planner = new StructuredModelPlanner({ generatePlan: async () => ({ steps: "not-an-array" }) });
  await assert.rejects(() => planner.createPlan(input), (error: unknown) => error instanceof CoreError && error.category === "PLANNING_ERROR");
});
