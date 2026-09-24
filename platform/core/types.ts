export type TaskStatus =
  | "RECEIVED" | "UNDERSTANDING" | "PLANNING" | "PLAN_VALIDATION" | "EXECUTING"
  | "OBSERVING" | "VALIDATING" | "RECOVERING" | "RETRYING" | "REPLANNING" | "ESCALATED"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT";

export type Priority = "low" | "normal" | "high" | "critical";
export type RiskLevel = "READ_ONLY" | "CONTROLLED" | "WRITE" | "DESTRUCTIVE";
export type SideEffect = "PURE" | "SIDE_EFFECTING";
export type Idempotency = "IDEMPOTENT" | "NON_IDEMPOTENT" | "UNKNOWN";
export type ValidationStatus = "VALID" | "INVALID" | "INCONCLUSIVE" | "REQUIRES_REPLAN";

export interface Artifact {
  artifactId: string;
  type: string;
  reference: string;
  producer: string;
  taskId: string;
  stepId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Provenance {
  source: string;
  locator?: string;
  executionId?: string;
  artifactIds: string[];
  evidence?: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  validator: string;
  message: string;
  evidenceIds?: string[];
  details?: Record<string, unknown>;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface PlanStep {
  stepId: string;
  description: string;
  skill?: string;
  tools: string[];
  dependencies: string[];
  expectedOutput: string;
  validationCriteria: string[];
  retryPolicy: RetryPolicy;
  timeoutMs: number;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";
}

export interface Plan {
  planId: string;
  objective: string;
  assumptions: string[];
  steps: PlanStep[];
  selectedSkills: string[];
  selectedTools: string[];
  expectedOutputs: string[];
  validationCriteria: string[];
  riskLevel: RiskLevel;
}

export interface Task {
  taskId: string;
  parentTaskId?: string;
  rootTaskId: string;
  userRequest: string;
  objective: string;
  constraints: Record<string, unknown>;
  priority: Priority;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  deadline?: string;
  currentPlan?: Plan;
  currentStep?: string;
  completedSteps: string[];
  failedSteps: string[];
  observations: string[];
  artifacts: Artifact[];
  selectedSkills: string[];
  selectedTools: string[];
  validationResults: ValidationResult[];
  retryCount: number;
  replanCount: number;
  context: { estimatedTokens: number; maxTokens: number };
  execution: Record<string, unknown>;
  finalResult?: unknown;
  failureReason?: string;
}

export interface SkillDescriptor {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  supportedInputs: string[];
  supportedOutputs: string[];
  requiredTools: string[];
  optionalTools: string[];
  dependencies: string[];
  constraints: string[];
  riskLevel: RiskLevel;
  examples: string[];
}

export interface ToolDescriptor {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  capabilities: string[];
  permissions: string[];
  riskLevel: RiskLevel;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  idempotency: Idempotency;
  sideEffect: SideEffect;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  metadata?: Record<string, unknown>;
  artifacts: Artifact[];
  warnings: string[];
  error?: { category: string; message: string; retryable: boolean };
  provenance: Provenance[];
  execution: ExecutionRecord;
}

export interface ExecutionRecord {
  executionId: string;
  taskId: string;
  stepId: string;
  tool: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "STARTED" | "COMPLETED" | "FAILED" | "CANCELLED";
  retryNumber: number;
  inputMetadata?: Record<string, unknown>;
  outputMetadata?: Record<string, unknown>;
  error?: { category: string; message: string; retryable: boolean };
}

export interface PolicyRequest {
  taskId: string;
  tool: ToolDescriptor;
  operation: string;
  input: unknown;
  approval?: boolean;
}

export type PolicyDecision =
  | { decision: "ALLOW" }
  | { decision: "DENY"; reason: string }
  | { decision: "REQUIRE_APPROVAL"; reason: string };

export interface ContextSource {
  id: string;
  kind: "instruction" | "task" | "plan" | "step" | "skill" | "tool" | "observation" | "artifact" | "memory" | "conversation";
  priority: number;
  estimatedTokens: number;
  content: string;
  required?: boolean;
}

export interface MemoryRecord {
  id: string;
  scope: "SESSION" | "PROJECT" | "LONG_TERM";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryStore {
  read(scope: MemoryRecord["scope"], query?: string): Promise<MemoryRecord[]>;
  write(record: Omit<MemoryRecord, "id" | "createdAt">): Promise<MemoryRecord>;
  search(scope: MemoryRecord["scope"], query: string): Promise<MemoryRecord[]>;
  delete(id: string): Promise<void>;
}
