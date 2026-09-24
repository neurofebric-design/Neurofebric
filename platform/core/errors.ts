export type ErrorCategory =
  | "TASK_ERROR" | "PLANNING_ERROR" | "SKILL_ERROR" | "TOOL_ERROR" | "VALIDATION_ERROR"
  | "POLICY_ERROR" | "CONTEXT_ERROR" | "MEMORY_ERROR" | "MODEL_ERROR" | "RECOVERY_ERROR"
  | "CONFIGURATION_ERROR";

export class CoreError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly taskId?: string;
  readonly stepId?: string;
  readonly executionId?: string;
  readonly cause?: unknown;

  constructor(
    category: ErrorCategory,
    message: string,
    options: { retryable?: boolean; taskId?: string; stepId?: string; executionId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CoreError";
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.taskId = options.taskId;
    this.stepId = options.stepId;
    this.executionId = options.executionId;
    this.cause = options.cause;
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}
