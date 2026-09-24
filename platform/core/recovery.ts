import { CoreError } from "./errors.ts";
import type { ExecutionRecord, Idempotency, Plan, Task, ToolResult } from "./types.ts";

export type FailureCategory = "TRANSIENT" | "PERMISSION" | "INVALID_INPUT" | "TOOL_FAILURE" | "TIMEOUT" | "RATE_LIMIT" | "MODEL_FAILURE" | "VALIDATION_FAILURE" | "DEPENDENCY_FAILURE" | "UNKNOWN";
export type RecoveryStrategy = "RETRY" | "MODIFY_INPUT" | "ALTERNATE_TOOL" | "ALTERNATE_SKILL" | "REPLAN" | "ESCALATE" | "TERMINATE";

export interface RecoveryLimits {
  maxToolRetries: number;
  maxStepRetries: number;
  maxReplans: number;
  maxRecoveryDepth: number;
  maxExecutionTimeMs: number;
}

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof CoreError) {
    if (error.category === "POLICY_ERROR") return "PERMISSION";
    if (error.category === "VALIDATION_ERROR") return "VALIDATION_FAILURE";
    if (error.category === "MODEL_ERROR") return "MODEL_FAILURE";
    if (error.category === "TOOL_ERROR") return error.retryable ? "TRANSIENT" : "TOOL_FAILURE";
  }
  return "UNKNOWN";
}

export function chooseRecovery(options: {
  failure: FailureCategory;
  limits: RecoveryLimits;
  retryCount: number;
  replanCount: number;
  depth: number;
  idempotency: Idempotency;
}): RecoveryStrategy {
  if (options.depth >= options.limits.maxRecoveryDepth) return "TERMINATE";
  if (options.failure === "PERMISSION" || options.failure === "INVALID_INPUT") return "ESCALATE";
  if (options.failure === "VALIDATION_FAILURE" && options.replanCount < options.limits.maxReplans) return "REPLAN";
  if (options.failure === "DEPENDENCY_FAILURE" && options.replanCount < options.limits.maxReplans) return "REPLAN";
  if (["TRANSIENT", "TIMEOUT", "RATE_LIMIT", "MODEL_FAILURE"].includes(options.failure)) {
    if (options.idempotency === "NON_IDEMPOTENT") return "ESCALATE";
    if (options.retryCount < options.limits.maxToolRetries) return "RETRY";
  }
  if (options.replanCount < options.limits.maxReplans) return "REPLAN";
  return "TERMINATE";
}

export function assertRecoveryBudget(limits: RecoveryLimits, retryCount: number, replanCount: number): void {
  if (retryCount > limits.maxToolRetries || replanCount > limits.maxReplans) {
    throw new CoreError("RECOVERY_ERROR", "Recovery budget exceeded", { retryable: false });
  }
}

export function preserveSuccessfulWork(previous: Plan, next: Plan, completedSteps: string[]): Plan {
  const completed = new Set(completedSteps);
  return { ...next, steps: next.steps.map((step) => completed.has(step.stepId) ? { ...step, status: "COMPLETED" } : step) };
}
