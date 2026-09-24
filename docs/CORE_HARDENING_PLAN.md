# Core Hardening Plan

## Audit Scope

This plan covers the Pi-based project at `agent-harness/` and the installed Pi `0.87.1` runtime. The nested `OmniRoute/` application is a separate model gateway project and is not part of the kernel implementation.

Reviewed:

- project configuration, skills, extension, platform helpers, and tests;
- legacy Python harness, policy engine, file tools, and LLM client;
- Pi skill discovery and lazy loading;
- Pi built-in tools and custom `registerTool()` contracts;
- Pi lifecycle events for context, sessions, turns, tool calls, tool execution, provider requests, and settlement;
- Pi model/provider configuration and project trust behavior.

## Current Architecture

```text
Pi
  -> platform-orchestrator.ts
     -> Pi native skill discovery (skills/)
     -> generic prompt guidance
     -> small in-memory trace
     -> destructive bash confirmation
  -> Pi native agent loop and built-in tools
  -> Pi model/provider layer
```

The existing Python harness is separate and remains a legacy/reference runtime. The current platform extension is intentionally thin but does not yet provide a durable task kernel.

## Existing Capabilities

### Provided by Pi

- agent loop and model/tool turn orchestration;
- built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools;
- tool schemas, tool results, streaming updates, and execution errors;
- session persistence, context messages, compaction, and branch handling;
- skill discovery from configured resource paths and lazy skill loading;
- extension registration for tools, commands, lifecycle events, and providers;
- `tool_call` interception and UI approval primitives;
- `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events;
- provider request/response hooks, retries, model switching, and usage metadata;
- project trust and resource loading controls.

### Added by this project

- project `skills/` discovery path;
- small skill metadata parser and catalog formatter;
- generic workflow prompt guidance;
- bounded in-memory trace display;
- initial destructive shell command gate;
- four deterministic unit tests for catalog and guidance behavior;
- architecture and skill contract documentation.

## Duplicated or Risking Duplication

The following must not be rebuilt in the kernel:

- a second model-call loop;
- a second provider client or OmniRoute-specific adapter;
- a second tool execution implementation for Pi built-in tools;
- a second session store or context compaction engine;
- a keyword-based skill router;
- a domain-specific policy branch for CSV, Splunk, SQL, or any other domain.

The current Python `AgentRunner` does duplicate an agent loop, but it is legacy code and is not called by the Pi extension. It should remain isolated until a migration decision is made.

## Weaknesses

1. The extension stores trace entries in module-global mutable state and does not persist structured events through `appendEntry()`.
2. Prompt previews are recorded without redaction and may contain secrets or sensitive user data.
3. The shell gate covers only a small set of command patterns and only `bash`; it is not a complete capability policy.
4. Skill metadata supports only `name` and `description`; there is no version, capability, input/output, tool, dependency, risk, or constraint contract.
5. Skill selection guidance is injected as prompt text rather than represented as a validated structured decision.
6. There is no task identifier, lifecycle state machine, plan, step, execution, validator, recovery, or provenance model.
7. There is no universal structured tool result or execution record.
8. There is no policy interface that can return `ALLOW`, `DENY`, or `REQUIRE_APPROVAL` independently of Pi UI.
9. There is no context budget or relevance engine; current guidance can grow with the skill catalog.
10. There are no integration, recovery, policy, security, or orchestration tests.
11. The current extension imports untyped `.mjs` helpers from TypeScript, so the project needs a deliberate TypeScript/module boundary before the kernel grows.
12. The current README still contains a large legacy Python harness section, which makes the active Pi path less clear.

## Target Kernel Boundaries

The kernel coordinates task state, plans, skills, tools, policy, validation, recovery, context, memory, events, artifacts, and provenance. It delegates actual model calls, context compaction, session persistence, built-in tool execution, and provider streaming to Pi.

```text
Pi native runtime
  -> kernel task lifecycle
     -> intent/objective record
     -> structured planner
     -> plan validator
     -> capability-oriented skill registry
     -> tool registry and policy gate
     -> Pi tool execution or registered tool
     -> result validator
     -> bounded recovery/replanning
     -> finalizer and provenance
```

The first implementation should use dependency-injected interfaces and deterministic fakes. The model and tool implementations remain replaceable.

## Components To Add

### Core types

- `Task`, hierarchical task identifiers, status, objective, constraints, plan, steps, observations, artifacts, validation results, counters, metadata, result, and failure.
- `Plan`, `PlanStep`, dependency graph, expected outputs, validation criteria, and retry policy.
- `SkillDescriptor`, capability metadata, input/output declarations, required/optional tools, dependencies, constraints, and risk.
- `ToolDescriptor`, typed input/output contracts, capabilities, permissions, risk, timeout, retry policy, idempotency, and side effects.
- `ToolResult`, `ExecutionRecord`, `ValidationOutcome`, `RecoveryDecision`, `Artifact`, `Provenance`, and structured error categories.

### Task manager and state machine

- explicit transition table;
- transition validation with typed errors;
- task creation and hierarchical child-task support;
- cancellation and deadline checks;
- persisted task state through Pi session entries or a future external store.

### Planner and plan validator

- planner interface returning a structured plan;
- pure plan validation for missing skills/tools, missing outputs, dependency cycles, permissions, and limits;
- plan representation capable of parallel branches without uncontrolled execution;
- replanning input that preserves completed work and observations.

### Execution and recovery

- execution wrapper around Pi tool calls;
- structured tool result normalization;
- validator interface with `VALID`, `INVALID`, `INCONCLUSIVE`, and `REQUIRES_REPLAN` outcomes;
- failure classification and bounded recovery decisions;
- retry safety based on idempotency and side-effect classification;
- cancellation propagation through Pi abort signals.

### Policy and approval

- provider-agnostic `PolicyEngine` interface;
- `ALLOW`, `DENY`, and `REQUIRE_APPROVAL` decisions;
- generic approval interface implemented by Pi UI;
- default deny for unknown or destructive operations;
- no domain-specific rules in the kernel.

### Events, trace, provenance, and artifacts

- typed event names and immutable event records;
- bounded in-memory event bus for the first phase;
- session-persisted trace summaries through `appendEntry()` where appropriate;
- redacted provenance links from final claims to tool executions and artifacts;
- artifact references without assuming file or database semantics.

### Context and memory

- `ContextEngine` interface with prioritized, bounded source selection;
- `MemoryStore` interface with explicit session/project/long-term scopes;
- no vector database and no concrete database in this phase;
- context budget metadata prepared for future model-specific limits.

### Configuration and limits

- validated central configuration with safe defaults;
- task, step, and tool timeouts;
- retry, recovery, replan, recursion, output, artifact, context, and concurrency limits;
- no uncontrolled parallel execution in the first implementation.

## Components To Modify

- `.pi/extensions/platform-orchestrator.ts`: become the Pi adapter, not the kernel itself;
- `platform/skill-registry.mjs`: either remain a compatibility adapter or be replaced by typed descriptors;
- `platform/orchestration.mjs`: move workflow/trace behavior behind typed core interfaces;
- `.pi/settings.json`: add project resource and runtime configuration only after the configuration schema exists;
- `README.md`: separate active Pi platform documentation from the legacy Python harness.

## Components To Leave Untouched

- Pi's agent loop and provider implementations;
- Pi's built-in tool implementations;
- Pi's session manager and context compaction;
- `OmniRoute/` source and configuration;
- legacy Python `core/`, `agents/`, `tools/`, and `policies/` until migration is explicitly approved;
- domain skill content and external connector implementations.

## Migration Strategy

1. Add pure, dependency-injected kernel modules under `platform/core/`.
2. Add deterministic tests before wiring the modules to Pi.
3. Add typed skill/tool descriptors and keep the existing parser as a compatibility boundary.
4. Add a Pi adapter that maps Pi lifecycle events into kernel events.
5. Replace the extension's direct prompt mutation and global trace with adapter calls.
6. Keep built-in Pi tools active, but classify them through a policy catalog before execution.
7. Add a single registered kernel inspection tool only if the model needs structured task state; do not register a duplicate execution tool.
8. Run unit, integration, orchestration, recovery, and security tests.
9. Only after the kernel is stable should the legacy Python harness be deprecated or integrated.

## Risks

- Pi extension APIs and internal event ordering can change between releases; pin and test against the installed Pi version.
- A prompt-only orchestrator cannot guarantee structured decisions; structured model output must be schema-validated and allowed to fail into recovery.
- Pi's built-in tools do not inherently carry the platform's risk metadata; an adapter-side catalog is required.
- Persisting full prompts, tool arguments, or outputs in session entries could leak secrets; redaction and bounded previews are mandatory.
- A global in-memory trace is not sufficient for recovery or distributed correlation; use task/execution IDs and session-backed summaries.
- Project trust is not a sandbox; OS isolation and scoped credentials remain deployment responsibilities.
- Overriding Pi built-in tools would create compatibility and security risk; prefer policy gating and explicit registered tools.

## Quality Gate For This Phase

The implementation is acceptable when:

- illegal task transitions are rejected;
- cyclic or incomplete plans cannot execute;
- tool execution produces structured success/error records;
- policy can deny or require approval without domain logic;
- retries and replans are bounded;
- non-idempotent destructive operations are not automatically retried;
- successful steps and provenance survive recovery;
- cancellation and deadlines are checked;
- traces are correlated and redacted;
- context assembly is bounded and prioritized;
- memory is accessed only through an interface;
- model/provider details remain outside the kernel;
- unit, integration, orchestration, recovery, and security tests pass without real credentials or real LLM calls.

## Next Implementation Slice

Implement the foundational types, task state machine, plan model/validator, typed errors, limits, and deterministic tests first. Do not wire a real planner or execute real tools until these contracts are tested.
