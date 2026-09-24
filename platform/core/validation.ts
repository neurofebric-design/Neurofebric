import { randomUUID } from "node:crypto";
import type { PlanStep, ToolDescriptor, ToolResult, ValidationResult } from "./types.ts";

export interface Validator {
  validateStep(step: PlanStep, result: ToolResult): Promise<ValidationResult>;
  validateTask(results: ValidationResult[]): Promise<ValidationResult>;
}

export function successfulResult(validator: string, message = "Result satisfies the declared criteria"): ValidationResult {
  return { status: "VALID", validator, message };
}

export function failedResult(validator: string, message: string, details?: Record<string, unknown>): ValidationResult {
  return { status: "INVALID", validator, message, details };
}

export function createExecutionId(): string {
  return randomUUID();
}

export class DefaultValidator implements Validator {
  async validateStep(step: PlanStep, result: ToolResult): Promise<ValidationResult> {
    if (!result.success) return failedResult("default", `Step ${step.stepId} returned a failed tool result`);
    if (!result.execution.endedAt) return { status: "INCONCLUSIVE", validator: "default", message: "Tool result has no completion timestamp" };
    if (step.expectedOutput && result.data === undefined) return failedResult("default", `Step ${step.stepId} produced no data`);
    return successfulResult("default");
  }

  async validateTask(results: ValidationResult[]): Promise<ValidationResult> {
    if (results.some((result) => result.status === "INVALID")) return { status: "REQUIRES_REPLAN", validator: "default", message: "One or more validation checks failed" };
    if (results.some((result) => result.status === "INCONCLUSIVE")) return { status: "INCONCLUSIVE", validator: "default", message: "One or more validation checks are inconclusive" };
    return successfulResult("default", "All validation checks passed");
  }
}
