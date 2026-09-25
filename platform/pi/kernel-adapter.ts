import { randomUUID } from "node:crypto";
import {
  CoreError,
  DefaultPolicy,
  EventBus,
  InMemoryStore,
  ToolRegistry,
  createTask,
  transitionTask,
  validatePlan,
  type ApprovalProvider,
  type Plan,
  type PlanStep,
  type PolicyDecision,
  type SkillDescriptor,
  type Task,
  type ToolDescriptor,
  type ToolResult,
  type ValidationResult,
} from "../core/index.ts";
import { chooseRecovery, classifyFailure, type RecoveryLimits } from "../core/index.ts";

export interface KernelAdapterOptions {
  skills?: SkillDescriptor[];
  limits?: RecoveryLimits;
  memory?: InMemoryStore;
}

export interface ToolCallDecision {
  decision: PolicyDecision;
  plan?: Plan;
  task?: Task;
}

function event(type: Parameters<EventBus["emit"]>[0]["type"], taskId: string, payload: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    type,
    taskId,
    correlationId: taskId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

export class KernelAdapter {
  readonly events = new EventBus();
  readonly tools: ToolRegistry;
  readonly memory: InMemoryStore;
  readonly policy = new DefaultPolicy();
  private readonly skills: SkillDescriptor[];
  private readonly limits: RecoveryLimits;
  private task?: Task;
  private plan?: Plan;
  private lastValidation?: ValidationResult;
  private readonly observedExecutionIds = new Set<string>();

  constructor(options: KernelAdapterOptions = {}) {
    this.tools = new ToolRegistry();
    this.memory = options.memory ?? new InMemoryStore();
    this.skills = options.skills ?? [];
    this.limits = options.limits ?? {
      maxToolRetries: 2,
      maxStepRetries: 1,
      maxReplans: 2,
      maxRecoveryDepth: 3,
      maxExecutionTimeMs: 30 * 60 * 1000,
    };
  }

  setSkills(skills: SkillDescriptor[]): void {
    this.skills.splice(0, this.skills.length, ...skills);
  }

  registerTools(descriptors: ToolDescriptor[]): void {
    for (const descriptor of descriptors) {
      if (!this.tools.has(descriptor.name)) this.tools.register(descriptor);
    }
  }

  get currentTask(): Task | undefined {
    return this.task;
  }

  get currentPlan(): Plan | undefined {
    return this.plan;
  }

  async beginTask(userRequest: string, objective = userRequest, constraints: Record<string, unknown> = {}): Promise<Task> {
    // Task state is explicit; Pi's transcript remains the source of conversational context.
    const task = createTask({ taskId: randomUUID(), userRequest, objective, constraints });
    this.task = task;
    this.plan = undefined;
    this.lastValidation = undefined;
    this.observedExecutionIds.clear();
    await this.events.emit(event("TASK_CREATED", task.taskId, { objective: task.objective }));
    this.task = transitionTask(this.task, "UNDERSTANDING");
    await this.events.emit(event("TASK_STARTED", task.taskId));
    this.task = transitionTask(this.task, "PLANNING");
    await this.events.emit(event("PLAN_CREATED", task.taskId, { state: this.task.status }));
    return this.task;
  }

  async planToolCall(toolName: string, input: unknown, inputMetadata?: Record<string, unknown>): Promise<ToolCallDecision> {
    if (!this.task) throw new Error("No active task");
    // Pi has already selected the operation; the kernel validates it before Pi executes it.
    // A completed validation within the same Pi user turn allows planning
    // of the next tool. Recovery and terminal states remain blocked.
    if (this.task.status === "VALIDATING" && this.lastValidation?.status === "VALID") {
      this.task = transitionTask(this.task, "PLANNING");
    }

    if (this.task.status !== "PLANNING") {
      throw new CoreError("TASK_ERROR", `Task cannot plan from state ${this.task.status}`, { taskId: this.task.taskId });
    }
    const tool = this.tools.get(toolName);
    const step: PlanStep = {
      stepId: `pi-${randomUUID().slice(0, 8)}`,
      description: `Execute Pi tool ${toolName}`,
      tools: [toolName],
      dependencies: [],
      expectedOutput: "Pi tool result",
      validationCriteria: ["Tool execution completed and returned a result"],
      retryPolicy: tool.retryPolicy,
      timeoutMs: tool.timeoutMs,
      status: "PENDING",
    };
    const plan: Plan = {
      planId: randomUUID(),
      objective: this.task.objective,
      assumptions: ["Pi selected the requested tool"],
      steps: [step],
      selectedSkills: this.skills.filter((skill) => skill.requiredTools.includes(toolName)).map((skill) => skill.name),
      selectedTools: [toolName],
      expectedOutputs: [step.expectedOutput],
      validationCriteria: [step.validationCriteria[0]],
      riskLevel: tool.riskLevel,
    };
    this.plan = plan;
    this.task = { ...this.task, currentPlan: plan, currentStep: step.stepId, selectedTools: [toolName], selectedSkills: plan.selectedSkills };
    this.task = transitionTask(this.task, "PLAN_VALIDATION");
    validatePlan(plan, this.skills, this.tools.list());
    await this.events.emit(event("PLAN_VALIDATED", this.task.taskId, { planId: plan.planId }));
    for (const skill of plan.selectedSkills) await this.events.emit(event("SKILL_SELECTED", this.task.taskId, { skill }));
    await this.events.emit(event("TOOL_SELECTED", this.task.taskId, { tool: toolName, inputMetadata }));
    this.task = transitionTask(this.task, "EXECUTING");
    return { decision: { decision: "ALLOW" }, plan, task: this.task };
  }

  async evaluateToolCall(toolName: string, operation: string, input: unknown, approval?: ApprovalProvider): Promise<ToolCallDecision> {
    const planned = await this.planToolCall(toolName, input);
    const policy = approval ? new DefaultPolicy(approval) : this.policy;
    const decision = approval
      ? await policy.evaluateWithApproval({ taskId: this.task!.taskId, tool: this.tools.get(toolName), operation, input })
      : policy.evaluate({ taskId: this.task!.taskId, tool: this.tools.get(toolName), operation, input });
    if (decision.decision === "REQUIRE_APPROVAL") await this.events.emit(event("APPROVAL_REQUIRED", this.task!.taskId, { tool: toolName }));
    if (decision.decision === "DENY") {
      await this.events.emit(event("APPROVAL_DENIED", this.task!.taskId, { tool: toolName, reason: decision.reason }));
      this.task = transitionTask(this.task!, "RECOVERING");
      this.task = transitionTask(this.task!, "FAILED");
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: decision.reason }));
    }
    return { ...planned, decision };
  }

  async observeToolResult(result: ToolResult, error?: unknown): Promise<ValidationResult> {
    if (!this.task || !this.plan?.steps[0]) throw new Error("No active tool step");
    const executionId = result.execution.executionId;

    // Pi can emit duplicate or late tool_execution_end events.
    // Only the active EXECUTING result may advance to OBSERVING.
    if (this.observedExecutionIds.has(executionId)) {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
        executionId,
        reason: "duplicate_execution_result",
      }));
      return {
        status: "INCONCLUSIVE",
        validator: "pi-result-dedup",
        message: "Duplicate tool result ignored",
      };
    }

    if (
      result.execution.taskId !== this.task.taskId ||
      result.execution.stepId !== this.task.currentStep ||
      this.task.status !== "EXECUTING"
    ) {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
        executionId,
        reason: "stale_or_out_of_order_result",
        taskStatus: this.task.status,
        currentStep: this.task.currentStep,
        resultTaskId: result.execution.taskId,
        resultStep: result.execution.stepId,
      }));
      return {
        status: "INCONCLUSIVE",
        validator: "pi-result-order",
        message: "Late or out-of-order tool result ignored",
      };
    }

    this.observedExecutionIds.add(executionId);

    // A successful tool call is not a successful task until validation passes.
    this.task = transitionTask(this.task, "OBSERVING");
    this.task = { ...this.task, observations: [...this.task.observations, result.success ? "Tool completed" : "Tool failed"] };
    await this.events.emit(event(result.success ? "TOOL_COMPLETED" : "TOOL_FAILED", this.task.taskId, { executionId: result.execution.executionId, error: error?.message }));
    this.task = transitionTask(this.task, "VALIDATING");
    const validation: ValidationResult = result.success
      ? { status: "VALID", validator: "pi-result", message: "Pi returned a successful tool result" }
      : { status: "INVALID", validator: "pi-result", message: error instanceof Error ? error.message : "Tool failed" };
    this.lastValidation = validation;
    this.task = { ...this.task, validationResults: [...this.task.validationResults, validation] };
    await this.events.emit(event(validation.status === "VALID" ? "VALIDATION_COMPLETED" : "VALIDATION_FAILED", this.task.taskId, validation as unknown as Record<string, unknown>));
    if (validation.status !== "VALID") {
      this.task = transitionTask(this.task, "RECOVERING");

      const tool = this.tools.get(result.execution.tool);
      const failure = classifyFailure(error);

      const strategy = chooseRecovery({
        failure,
        limits: this.limits,
        retryCount: this.task.retryCount,
        replanCount: this.task.replanCount,
        depth: this.recoveryDepth,
        idempotency: tool.idempotency,
      });

      this.recoveryDepth += 1;

      await this.events.emit(event("RECOVERY_STARTED", this.task.taskId, {
        strategy,
        failure,
        recoveryDepth: this.recoveryDepth,
      }));

      switch (strategy) {
        case "RETRY":
          this.task = {
            ...this.task,
            retryCount: this.task.retryCount + 1,
          };

          this.task = transitionTask(this.task, "RETRYING");
          this.task = transitionTask(this.task, "PLANNING");
          break;

        case "REPLAN":
          this.task = {
            ...this.task,
            replanCount: this.task.replanCount + 1,
          };

          this.task = transitionTask(this.task, "REPLANNING");
          this.task = transitionTask(this.task, "PLANNING");
          break;

        case "ESCALATE":
          this.task = transitionTask(this.task, "ESCALATED");
          break;

        case "TERMINATE":
        default:
          this.task = transitionTask(this.task, "FAILED");

          await this.events.emit(event("TASK_FAILED", this.task.taskId, {
            reason: "Recovery budget exhausted or no safe recovery strategy remains",
            strategy,
          }));
          break;
      }
    } else {
      this.recoveryDepth = 0;
    }

    return validation;
  }

  async finishTask(finalResult: unknown): Promise<Task> {
    if (!this.task) throw new Error("No active task");
    if (this.task.status === "RECOVERING") {
      this.task = transitionTask(this.task, "FAILED");
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "Recovery requires a new planning turn" }));
      return this.task;
    }
    if (!this.plan) {
      const step: PlanStep = { stepId: "response", description: "Return response", tools: [], dependencies: [], expectedOutput: "Response", validationCriteria: ["Response produced"], retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 }, timeoutMs: 1000, status: "PENDING" };
      this.plan = { planId: randomUUID(), objective: this.task.objective, assumptions: [], steps: [step], selectedSkills: [], selectedTools: [], expectedOutputs: ["Response"], validationCriteria: ["Response produced"], riskLevel: "READ_ONLY" };
      this.task = { ...this.task, currentPlan: this.plan };
    }
    if (this.task.status === "PLANNING") this.task = transitionTask(this.task, "PLAN_VALIDATION");
    if (this.task.status === "PLAN_VALIDATION") this.task = transitionTask(this.task, "EXECUTING");
    if (this.task.status === "EXECUTING") this.task = transitionTask(this.task, "OBSERVING");
    if (this.task.status === "OBSERVING") this.task = transitionTask(this.task, "VALIDATING");
    if (this.task.status === "VALIDATING" && this.lastValidation?.status !== "INVALID") {
      this.task = transitionTask(this.task, "COMPLETED", new Date().toISOString());
      this.task = { ...this.task, finalResult };
      await this.events.emit(event("TASK_COMPLETED", this.task.taskId));
    } else if (this.task.status === "VALIDATING") {
      this.task = transitionTask(this.task, "FAILED");
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "Validation failed" }));
    }
    return this.task;
  }

  recentEvents() {
    return this.events.recent();
  }
}
