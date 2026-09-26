import { randomUUID } from "node:crypto";
import {
  CoreError,
  DefaultPolicy,
  EventBus,
  InMemoryStore,
  ToolRegistry,
  createArtifact,
  createTask,
  declaredArtifactReferences,
  redactString,
  transitionTask,
  validatePlan,
  skillsForCapabilities,
  verifyArtifacts,
  WorkspaceBoundary,
  type ApprovalProvider,
  type Artifact,
  type Plan,
  type PlanStep,
  type PolicyDecision,
  type PolicyEngine,
  type SkillDescriptor,
  type Task,
  type TaskStatus,
  type ToolDescriptor,
  type ToolResult,
  type ValidationResult,
} from "../core/index.ts";
import { chooseRecovery, classifyFailure, type RecoveryLimits } from "../core/index.ts";

export interface KernelAdapterOptions {
  skills?: SkillDescriptor[];
  limits?: RecoveryLimits;
  memory?: InMemoryStore;
  /**
   * Workspace boundary used to verify produced artifacts. When absent,
   * artifacts are still checked for existence and content but not for
   * containment.
   */
  boundary?: WorkspaceBoundary;
}

export interface ToolCallDecision {
  decision: PolicyDecision;
  plan?: Plan;
  task?: Task;
}

/**
 * A real tool execution bound to the task, identified by Pi's toolCallId.
 * This is the only identity used to correlate tool_execution_end.
 */
export interface BoundExecution {
  toolCallId: string;
  executionId: string;
  planId: string;
  stepId: string;
  tool: string;
  startedAt: string;
}

/**
 * States from which a *new* tool execution must not be admitted.
 * RECOVERING/REPLANNING mean the kernel is deciding what to do next,
 * and the rest are terminal.
 */
const REFUSED_EXECUTION_STATES: readonly TaskStatus[] = [
  "RECOVERING",
  "REPLANNING",
  "ESCALATED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
];

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
  /**
   * Active policy. Defaults to approval mode so that an unconfigured embedding
   * keeps the conservative behaviour; a trusted project installs
   * `TrustedProjectPolicy` explicitly.
   */
  policy: PolicyEngine = new DefaultPolicy();
  private readonly skills: SkillDescriptor[];
  private readonly limits: RecoveryLimits;
  private readonly boundary?: WorkspaceBoundary;
  private task?: Task;
  private plan?: Plan;
  private lastValidation?: ValidationResult;
  private recoveryDepth = 0;

  /** Real executions currently in flight, keyed by Pi toolCallId. */
  private readonly activeExecutions = new Map<string, BoundExecution>();
  /** Every toolCallId that has been admitted (started or policy-denied) at preflight. */
  private readonly knownToolCallIds = new Set<string>();
  /** Preflight-denied toolCallIds; Pi may still emit an execution_start for them. */
  private readonly deniedToolCallIds = new Set<string>();
  /** Execution ids whose result has already been observed. */
  private readonly observedExecutionIds = new Set<string>();
  /** Output references declared at preflight, keyed by Pi toolCallId. */
  private readonly declaredOutputs = new Map<string, string[]>();
  /** Artifacts confirmed for this task. */
  private artifactList: Artifact[] = [];
  /**
   * Whether the *current* attempt has an unresolved failure.
   *
   * Reset when a new execution round begins, so a failure that recovery has
   * legitimately retried does not block completion forever, while a failure
   * inside the current round (for example a sibling execution) still does.
   */
  private attemptBlocked = false;
  /** Number of real tool executions bound to this task (drives honest finalisation). */
  private toolExecutionCount = 0;

  constructor(options: KernelAdapterOptions = {}) {
    this.tools = new ToolRegistry();
    this.memory = options.memory ?? new InMemoryStore();
    this.skills = options.skills ?? [];
    this.boundary = options.boundary;
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

  get skills(): SkillDescriptor[] {
    return [...this.skills];
  }

  findSkillsByCapabilities(capabilities: string[]): SkillDescriptor[] {
    return skillsForCapabilities(this.skills, capabilities);
  }

  /** Install the policy used by preflight. Used to select the trust model. */
  setPolicy(policy: PolicyEngine): void {
    this.policy = policy;
  }

  /**
   * Record the output references a model-requested tool call declares.
   *
   * Called from Pi's `tool_call` preflight, which is the only lifecycle event
   * that carries the tool input. Whether a call declares artifacts at all is
   * derived from the tool's `sideEffect` classification, so read-only tools
   * record no outputs and free-form shell commands are not guessed at.
   */
  declareToolOutputs(toolCallId: string, toolName: string, input: unknown): string[] {
    if (!this.task) throw new Error("No active task");
    const references = declaredArtifactReferences(this.tools.get(toolName), input);
    if (references.length > 0) this.declaredOutputs.set(toolCallId, references);
    return references;
  }

  /** Artifacts confirmed for the current task. */
  get artifacts(): Artifact[] {
    return [...this.artifactList];
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

  /** Real executions currently in flight. Used by the Pi adapter to correlate results. */
  activeExecution(toolCallId: string): BoundExecution | undefined {
    return this.activeExecutions.get(toolCallId);
  }

  async beginTask(userRequest: string, objective = userRequest, constraints: Record<string, unknown> = {}): Promise<Task> {
    // Task state is explicit; Pi's transcript remains the source of conversational context.
    const task = createTask({ taskId: randomUUID(), userRequest, objective, constraints });
    this.task = task;
    this.plan = undefined;
    this.lastValidation = undefined;
    this.recoveryDepth = 0;
    this.activeExecutions.clear();
    this.knownToolCallIds.clear();
    this.deniedToolCallIds.clear();
    this.observedExecutionIds.clear();
    this.declaredOutputs.clear();
    this.artifactList = [];
    this.attemptBlocked = false;
    this.toolExecutionCount = 0;
    await this.events.emit(event("TASK_CREATED", task.taskId, { objective: task.objective }));
    this.task = transitionTask(this.task, "UNDERSTANDING");
    await this.events.emit(event("TASK_STARTED", task.taskId));
    this.task = transitionTask(this.task, "PLANNING");
    await this.events.emit(event("PLAN_CREATED", task.taskId, { state: this.task.status }));
    return this.task;
  }

  // ---------------------------------------------------------------------------
  // POLICY PRECHECK  (Pi `tool_call` — a preflight interception hook)
  // ---------------------------------------------------------------------------

  /**
   * Policy evaluation only. This is called from Pi's `tool_call` preflight hook,
   * which may fire several times *before* any tool actually executes.
   *
   * It therefore must not create a plan, must not bind a step, and must not
   * move the task through the lifecycle. It is intentionally side-effect free
   * with respect to task state.
   */
  async precheckToolCall(
    toolName: string,
    operation: string,
    input: unknown,
    approval?: ApprovalProvider,
    toolCallId?: string,
  ): Promise<ToolCallDecision> {
    if (!this.task) throw new Error("No active task");
    // Unknown tools are rejected here, before Pi executes anything.
    const tool = this.tools.get(toolName);
    // An approval provider must never be able to *replace* the installed trust
    // model. In TRUSTED_PROJECT mode it is ignored outright, so no caller can
    // escalate a hard denial by passing an always-approving provider.
    const trusted = this.policy.mode === "TRUSTED_PROJECT";
    const policy = !trusted && approval ? new DefaultPolicy(approval) : this.policy;
    const request = { taskId: this.task.taskId, tool, operation, input };
    // Evaluate first so that an approval prompt is traced even when it is granted.
    const required = policy.evaluate(request);
    const decision = !trusted && approval ? await policy.evaluateWithApproval(request) : required;

    if (required.decision === "REQUIRE_APPROVAL") {
      await this.events.emit(event("APPROVAL_REQUIRED", this.task.taskId, { tool: toolName, toolCallId }));
    }
    if (decision.decision === "DENY") {
      if (toolCallId) {
        // Remember the denial so a later execution_start for this id is ignored
        // rather than turned into a fake successful execution.
        this.deniedToolCallIds.add(toolCallId);
        this.knownToolCallIds.add(toolCallId);
      }
      await this.events.emit(event("APPROVAL_DENIED", this.task.taskId, { tool: toolName, toolCallId, reason: decision.reason }));
    }
    return { decision, task: this.task };
  }

  // ---------------------------------------------------------------------------
  // EXECUTION START  (Pi `tool_execution_start` — the real execution)
  // ---------------------------------------------------------------------------

  /**
   * Bind a real tool execution to the task. This is the only place that creates
   * a plan/step and advances the lifecycle:
   *
   *   PLANNING -> PLAN_VALIDATION -> EXECUTING
   *
   * Correlated by Pi's toolCallId. Duplicate starts, preflight-denied calls and
   * unauthorised task states are ignored rather than corrupting state.
   */
  async beginToolExecution(toolCallId: string, toolName: string, inputMetadata?: Record<string, unknown>): Promise<BoundExecution | undefined> {
    if (!this.task) throw new Error("No active task");
    const taskId = this.task.taskId;

    if (this.deniedToolCallIds.has(toolCallId)) {
      // Pi emits execution_start around a blocked preflight. Never fabricate
      // an execution plan for a call policy refused.
      await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, { toolCallId, tool: toolName, reason: "policy_denied" }));
      return undefined;
    }

    if (this.knownToolCallIds.has(toolCallId) || this.activeExecutions.has(toolCallId)) {
      await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, { toolCallId, tool: toolName, reason: "duplicate_execution_start" }));
      return undefined;
    }

    if (REFUSED_EXECUTION_STATES.includes(this.task.status)) {
      await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, {
        toolCallId,
        tool: toolName,
        reason: "task_state_not_authorised",
        taskStatus: this.task.status,
      }));
      return undefined;
    }

    const tool = this.tools.get(toolName);

    // Pi's default tool execution mode is "parallel": several tool_execution_start
    // events are emitted before any of them finishes. Siblings join the EXECUTING
    // phase instead of re-entering PLANNING.
    const joiningSibling = this.task.status === "EXECUTING" && this.activeExecutions.size > 0;

    if (!joiningSibling) {
      if (this.task.status === "VALIDATING") {
        // A completed validation is the real planning boundary for the next tool.
        if (this.lastValidation?.status !== "VALID") {
          await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, {
            toolCallId,
            tool: toolName,
            reason: "last_validation_not_valid",
            taskStatus: this.task.status,
          }));
          return undefined;
        }
        this.task = transitionTask(this.task, "PLANNING");
      }
      if (this.task.status !== "PLANNING") {
        await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, {
          toolCallId,
          tool: toolName,
          reason: "task_state_not_authorised",
          taskStatus: this.task.status,
        }));
        return undefined;
      }

      const { plan, step } = this.buildPlanStep(toolName, tool);
      // A new execution round starts here; previous-round failures have already
      // been handed to recovery and must not block this round's completion.
      this.attemptBlocked = false;
      this.plan = plan;
      this.task = {
        ...this.task,
        currentPlan: plan,
        currentStep: step.stepId,
        selectedTools: [toolName],
        selectedSkills: plan.selectedSkills,
      };
      this.task = transitionTask(this.task, "PLAN_VALIDATION");
      validatePlan(plan, this.skills, this.tools.list());
      await this.events.emit(event("PLAN_VALIDATED", taskId, { planId: plan.planId, toolCallId }));
      for (const skill of plan.selectedSkills) await this.events.emit(event("SKILL_SELECTED", taskId, { skill }));
      await this.events.emit(event("TOOL_SELECTED", taskId, { tool: toolName, toolCallId, inputMetadata }));
      this.task = transitionTask(this.task, "EXECUTING");
    }

    const bound: BoundExecution = {
      toolCallId,
      executionId: toolCallId,
      planId: this.plan?.planId ?? "",
      stepId: joiningSibling ? `pi-${randomUUID().slice(0, 8)}` : this.task.currentStep!,
      tool: toolName,
      startedAt: new Date().toISOString(),
    };

    this.knownToolCallIds.add(toolCallId);
    this.activeExecutions.set(toolCallId, bound);
    this.toolExecutionCount += 1;
    await this.events.emit(event("TOOL_EXECUTION_STARTED", taskId, { toolCallId, tool: toolName, stepId: bound.stepId, joiningSibling }));
    return bound;
  }

  private buildPlanStep(toolName: string, tool: ToolDescriptor): { plan: Plan; step: PlanStep } {
    const task = this.task!;
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
      objective: task.objective,
      assumptions: ["Pi selected the requested tool"],
      steps: [step],
      selectedSkills: this.skills.filter((skill) => skill.requiredTools.includes(toolName)).map((skill) => skill.name),
      selectedTools: [toolName],
      expectedOutputs: [step.expectedOutput],
      validationCriteria: [step.validationCriteria[0]],
      riskLevel: tool.riskLevel,
    };
    return { plan, step };
  }

  // ---------------------------------------------------------------------------
  // EXECUTION END  (Pi `tool_execution_end` — observation and validation)
  // ---------------------------------------------------------------------------

  async observeToolResult(result: ToolResult, error?: unknown): Promise<ValidationResult> {
    if (!this.task) throw new Error("No active tool step");
    const executionId = result.execution.executionId;

    // Pi can emit duplicate tool_execution_end events.
    if (this.observedExecutionIds.has(executionId)) {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, { executionId, reason: "duplicate_execution_result" }));
      return { status: "INCONCLUSIVE", validator: "pi-result-dedup", message: "Duplicate tool result ignored" };
    }

    const bound = this.resolveBoundExecution(executionId, result.execution.stepId);

    // Only a real active execution may advance the lifecycle. This also rejects
    // late/out-of-order results, so we never attempt VALIDATING -> OBSERVING or
    // RECOVERING -> OBSERVING.
    if (!bound || result.execution.taskId !== this.task.taskId || this.task.status !== "EXECUTING") {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
        executionId,
        reason: bound ? "stale_or_out_of_order_result" : "no_active_execution",
        taskStatus: this.task.status,
        boundStep: bound?.stepId,
        resultTaskId: result.execution.taskId,
        resultStep: result.execution.stepId,
      }));
      return { status: "INCONCLUSIVE", validator: "pi-result-order", message: "Late or out-of-order tool result ignored" };
    }

    // Stale step identity: the result must belong to the execution it claims.
    if (result.execution.stepId !== bound.stepId) {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
        executionId,
        reason: "stale_step_id",
        boundStep: bound.stepId,
        resultStep: result.execution.stepId,
      }));
      return { status: "INCONCLUSIVE", validator: "pi-result-order", message: "Stale step id ignored" };
    }

    this.observedExecutionIds.add(executionId);
    this.activeExecutions.delete(executionId);

    await this.events.emit(event(result.success ? "TOOL_COMPLETED" : "TOOL_FAILED", this.task.taskId, {
      executionId,
      stepId: bound.stepId,
      tool: result.execution.tool,
      error: error?.message,
    }));

    // Verification is not "the tool returned success". When a call declared
    // outputs, those outputs must actually exist, be readable, be non-empty and
    // sit inside the workspace. A tool that reports success without producing
    // its declared artifact is INVALID.
    const invalidArtifacts = result.artifacts.filter((artifact) => artifact.trust === "INVALID");
    const unverifiedArtifacts = result.artifacts.filter((artifact) => artifact.trust === "UNVERIFIED");

    let validation: ValidationResult;
    if (!result.success) {
      validation = { status: "INVALID", validator: "pi-result", message: redactString(error instanceof Error ? error.message : "Tool failed") };
    } else if (invalidArtifacts.length > 0) {
      validation = {
        status: "INVALID",
        validator: "artifact-verification",
        message: `Tool reported success but ${invalidArtifacts.length} declared artifact(s) failed verification: ${invalidArtifacts.map((a) => `${a.reference} (${a.verification?.reason})`).join("; ")}`,
      };
      await this.events.emit(event("VALIDATION_FAILED", this.task.taskId, { reason: "declared_artifact_invalid", artifacts: invalidArtifacts.map((a) => a.reference) }));
    } else if (unverifiedArtifacts.length > 0) {
      validation = {
        status: "INCONCLUSIVE",
        validator: "artifact-verification",
        message: `Declared artifact(s) could not be verified: ${unverifiedArtifacts.map((a) => `${a.reference} (${a.verification?.reason})`).join("; ")}`,
      };
    } else if (result.artifacts.length > 0) {
      validation = {
        status: "VALID",
        validator: "artifact-verification",
        message: `${result.artifacts.length} declared artifact(s) verified on disk`,
      };
    } else {
      validation = { status: "VALID", validator: "pi-result", message: "Pi returned a successful tool result" };
    }

    if (validation.status === "INVALID" || validation.status === "INCONCLUSIVE") {
      this.attemptBlocked = true;
    }

    // Sibling executions from the same assistant message are still in flight;
    // the task stays EXECUTING until the last one settles.
    if (this.activeExecutions.size > 0) {
      this.task = {
        ...this.task,
        observations: [...this.task.observations, result.success ? "Tool completed" : "Tool failed"],
        validationResults: [...this.task.validationResults, validation],
      };
      return validation;
    }

    // Last execution: observe, then validate.
    this.task = transitionTask(this.task, "OBSERVING");
    this.task = { ...this.task, observations: [...this.task.observations, result.success ? "Tool completed" : "Tool failed"] };
    this.task = transitionTask(this.task, "VALIDATING");
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
      await this.events.emit(event("RECOVERY_STARTED", this.task.taskId, { strategy, failure, recoveryDepth: this.recoveryDepth }));

      switch (strategy) {
        case "RETRY":
          this.task = { ...this.task, retryCount: this.task.retryCount + 1 };
          this.task = transitionTask(this.task, "RETRYING");
          this.task = transitionTask(this.task, "PLANNING");
          break;
        case "REPLAN":
          this.task = { ...this.task, replanCount: this.task.replanCount + 1 };
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

  /**
   * Convenience entry point for the Pi adapter: builds a normalized result from
   * the *bound* execution identity so task/step correlation cannot drift.
   *
   * Declared outputs are verified against the filesystem before the result is
   * accepted. A tool that reports success without actually producing its
   * declared artifact is INVALID, not VALID.
   */
  async recordToolResult(toolCallId: string, toolName: string, payload: unknown, isError: boolean): Promise<ValidationResult> {
    if (!this.task) throw new Error("No active task");
    const bound = this.activeExecutions.get(toolCallId);
    const now = new Date().toISOString();
    const taskId = this.task.taskId;
    const stepId = bound?.stepId ?? this.task.currentStep ?? "unknown";
    const tool = this.tools.get(toolName);

    const declared = this.declaredOutputs.get(toolCallId) ?? [];
    const candidates: Artifact[] = declared.map((reference) =>
      createArtifact({
        reference,
        descriptor: tool,
        taskId,
        stepId,
        executionId: toolCallId,
        origin: "TOOL_DECLARED",
      }),
    );

    const report = candidates.length > 0
      ? await verifyArtifacts(candidates, this.boundary ? { boundary: this.boundary } : {})
      : { artifacts: [], invalid: [], unverified: [], allVerified: false };

    if (report.artifacts.length > 0) {
      this.artifactList = [...this.artifactList, ...report.artifacts];
      for (const artifact of report.artifacts) {
        await this.events.emit(event(artifact.trust === "INVALID" ? "ARTIFACT_INVALID" : "ARTIFACT_VERIFIED", taskId, {
          artifactId: artifact.artifactId,
          reference: artifact.reference,
          kind: artifact.type,
          producer: artifact.producer,
          taskId: artifact.taskId,
          stepId: artifact.stepId,
          status: artifact.verification?.status,
          reason: artifact.verification?.reason,
          sizeBytes: artifact.verification?.sizeBytes,
          // A content digest, not a credential. It is emitted so a claim can be
          // re-checked later; the redactor deliberately leaves digests intact.
          sha256: artifact.verification?.sha256,
        }));
      }
    }

    const result: ToolResult = {
      success: !isError,
      data: isError ? undefined : payload,
      metadata: { toolCallId },
      artifacts: report.artifacts,
      warnings: report.unverified.map((artifact) => `Artifact could not be verified: ${artifact.reference} (${artifact.verification?.reason})`),
      error: isError ? { category: "TOOL_ERROR", message: "Pi reported a tool error", retryable: false } : undefined,
      provenance: this.provenanceFor(toolName, toolCallId, stepId, declared),
      execution: {
        executionId: toolCallId,
        taskId,
        stepId,
        tool: toolName,
        startedAt: bound?.startedAt ?? now,
        endedAt: now,
        status: isError ? "FAILED" : "COMPLETED",
        retryNumber: 0,
      },
    };

    this.task = { ...this.task, artifacts: [...this.task.artifacts, ...report.artifacts] };
    return this.observeToolResult(result, isError ? new Error("Pi reported a tool error") : undefined);
  }

  /**
   * Provenance for an execution: what ran, and which references it touched.
   *
   * Only facts are recorded. A reference is listed as an output locator only
   * when the tool was actually declared to write it, so a read path is never
   * presented as a produced artifact.
   */
  private provenanceFor(toolName: string, toolCallId: string, stepId: string, declared: string[]): ToolResult["provenance"] {
    const produced = this.tools.get(toolName).sideEffect === "SIDE_EFFECTING";
    return [{
      source: toolName,
      // Provenance strings can carry connection strings or credentials echoed
      // back by a tool, so they cross the same boundary as everything else.
      locator: declared.length > 0 ? redactString(declared.join(", ")) : undefined,
      executionId: toolCallId,
      artifactIds: produced ? this.artifactList.filter((a) => a.stepId === stepId).map((a) => a.artifactId) : [],
      evidence: declared.length > 0
        ? `${declared.length} declared output reference(s) verified against the filesystem`
        : "no output references declared for this call",
    }];
  }

  /**
   * Resolve which execution a result belongs to.
   *
   * Normal path: a real execution bound at tool_execution_start.
   * Fallback: a direct kernel caller (unit tests / non-Pi embedding) that drove
   * the legacy planToolCall path, where the sole EXECUTING step is the target.
   */
  private resolveBoundExecution(executionId: string, stepId: string): BoundExecution | undefined {
    const bound = this.activeExecutions.get(executionId);
    if (bound) return bound;
    if (this.activeExecutions.size === 0 && this.task?.status === "EXECUTING" && this.task.currentStep === stepId) {
      return {
        toolCallId: executionId,
        executionId,
        planId: this.plan?.planId ?? "",
        stepId,
        tool: this.plan?.selectedTools[0] ?? "unknown",
        startedAt: new Date().toISOString(),
      };
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // LEGACY DIRECT-KERNEL ENTRY POINTS
  // ---------------------------------------------------------------------------

  /**
   * Plan a tool call without an execution identity. Retained for direct kernel
   * embeddings and existing tests; the Pi adapter uses the precheck/execution
   * lifecycle above instead.
   */
  async planToolCall(toolName: string, _input: unknown, inputMetadata?: Record<string, unknown>): Promise<ToolCallDecision> {
    if (!this.task) throw new Error("No active task");
    if (this.task.status !== "PLANNING") {
      throw new CoreError("TASK_ERROR", `Task cannot plan from state ${this.task.status}`, { taskId: this.task.taskId });
    }
    const tool = this.tools.get(toolName);
    const { plan, step } = this.buildPlanStep(toolName, tool);
    this.plan = plan;
    this.task = { ...this.task, currentPlan: plan, currentStep: step.stepId, selectedTools: [toolName], selectedSkills: plan.selectedSkills };
    this.task = transitionTask(this.task, "PLAN_VALIDATION");
    validatePlan(plan, this.skills, this.tools.list());
    await this.events.emit(event("PLAN_VALIDATED", this.task.taskId, { planId: plan.planId }));
    for (const skill of plan.selectedSkills) await this.events.emit(event("SKILL_SELECTED", this.task.taskId, { skill }));
    await this.events.emit(event("TOOL_SELECTED", this.task.taskId, { tool: toolName, inputMetadata }));
    this.task = transitionTask(this.task, "EXECUTING");
    this.toolExecutionCount += 1;
    return { decision: { decision: "ALLOW" }, plan, task: this.task };
  }

  /**
   * Legacy combined entry point: plan, then evaluate policy, failing the task on
   * denial. The Pi adapter must use `precheckToolCall` + `beginToolExecution`
   * instead; this exists for direct kernel callers and legacy tests.
   */
  async evaluateToolCall(toolName: string, operation: string, input: unknown, approval?: ApprovalProvider): Promise<ToolCallDecision> {
    // Legacy ordering: plan first, then evaluate. Denial recovery therefore runs
    // from EXECUTING (EXECUTING -> RECOVERING -> FAILED), as it always has.
    const planned = await this.planToolCall(toolName, input);
    const precheck = await this.precheckToolCall(toolName, operation, input, approval);
    if (precheck.decision.decision === "DENY") {
      this.task = transitionTask(this.task!, "RECOVERING");
      this.task = transitionTask(this.task!, "FAILED");
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: precheck.decision.reason }));
      return { decision: precheck.decision, task: this.task };
    }
    return { ...planned, decision: precheck.decision };
  }

  // ---------------------------------------------------------------------------
  // FINALISATION
  // ---------------------------------------------------------------------------

  async finishTask(finalResult: unknown): Promise<Task> {
    if (!this.task) throw new Error("No active task");
    if (this.task.status === "RECOVERING") {
      this.task = transitionTask(this.task, "FAILED");
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "Recovery requires a new planning turn" }));
      return this.task;
    }

    if (this.toolExecutionCount > 0) {
      // A task that really executed tools is only complete from its own real
      // validation. Never fabricate an OBSERVING/VALIDATING pass here.
      if (this.task.status !== "VALIDATING") {
        await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
          reason: "finish_without_validated_execution",
          taskStatus: this.task.status,
        }));
        return this.task;
      }
      if (this.lastValidation?.status === "INVALID") {
        this.task = transitionTask(this.task, "FAILED");
        await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "Validation failed" }));
        return this.task;
      }
      // A sibling execution may have failed validation while another was still
      // in flight. A task whose CURRENT attempt has any unresolved failure is
      // not complete, regardless of which result happened to settle last.
      if (this.attemptBlocked) {
        await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, { reason: "prior_validation_failed" }));
        this.task = transitionTask(this.task, "FAILED");
        await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "One or more results in this attempt failed or could not be verified" }));
        return this.task;
      }
      this.task = transitionTask(this.task, "COMPLETED", new Date().toISOString());
      this.task = { ...this.task, finalResult };
      await this.events.emit(event("TASK_COMPLETED", this.task.taskId));
      return this.task;
    }

    // No-tool task: the assistant response is the real executed step, so the
    // response is planned, executed, observed and validated for real.
    const step: PlanStep = {
      stepId: "response",
      description: "Return response",
      tools: [],
      dependencies: [],
      expectedOutput: "Response",
      validationCriteria: ["Response produced"],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      timeoutMs: 1000,
      status: "PENDING",
    };
    const plan: Plan = {
      planId: randomUUID(),
      objective: this.task.objective,
      assumptions: [],
      steps: [step],
      selectedSkills: [],
      selectedTools: [],
      expectedOutputs: ["Response"],
      validationCriteria: ["Response produced"],
      riskLevel: "READ_ONLY",
    };
    this.plan = plan;
    this.task = { ...this.task, currentPlan: plan, currentStep: step.stepId };
    this.task = transitionTask(this.task, "PLAN_VALIDATION");
    validatePlan(plan, this.skills, this.tools.list());
    await this.events.emit(event("PLAN_VALIDATED", this.task.taskId, { planId: plan.planId }));
    this.task = transitionTask(this.task, "EXECUTING");

    this.task = transitionTask(this.task, "OBSERVING");
    this.task = { ...this.task, observations: [...this.task.observations, "Assistant response produced"] };
    await this.events.emit(event("RESPONSE_OBSERVED", this.task.taskId));
    this.task = transitionTask(this.task, "VALIDATING");

    const validation: ValidationResult = { status: "VALID", validator: "pi-response", message: "Assistant produced a response" };
    this.lastValidation = validation;
    this.task = { ...this.task, validationResults: [...this.task.validationResults, validation] };
    await this.events.emit(event("VALIDATION_COMPLETED", this.task.taskId, validation as unknown as Record<string, unknown>));

    this.task = transitionTask(this.task, "COMPLETED", new Date().toISOString());
    this.task = { ...this.task, finalResult };
    await this.events.emit(event("TASK_COMPLETED", this.task.taskId));
    return this.task;
  }

  recentEvents() {
    return this.events.recent();
  }
}
