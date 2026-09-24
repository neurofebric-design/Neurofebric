# Pi Integration

## Audit Result

Pi already owns the agent loop, model interaction, built-in tool execution, sessions, context compaction, provider streaming, retries, and native skill loading. Neurofebric must not replace those systems.

The live integration uses Pi as the execution runtime and the typed kernel as a coordination layer around it.

## Verified Pi APIs

The installed Pi `0.87.1` extension types and examples provide:

- `before_agent_start`: raw user prompt and mutable system prompt sections;
- `resources_discover`: additional skill paths;
- `tool_call`: inspect or block a model-requested tool call;
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`: observe deterministic tool execution;
- `agent_start`, `agent_end`, `agent_settled`: lifecycle boundaries;
- `appendEntry()`: persist non-context state in the active Pi session;
- `getAllTools()` and `getActiveTools()`: inspect configured tools;
- `setActiveTools()`: change active tools;
- `ctx.ui.select()` / `ctx.ui.confirm()`: interactive approval adapter;
- `ctx.hasUI`: fail-closed behavior for non-interactive runs;
- `registerCommand()`: operator commands;
- `registerTool()`: future Neurofebric tool adapters;
- `registerProvider()`: only for unsupported provider protocols, not for OmniRoute's compatible endpoint.

Pi's built-in tools are not replaced. Pi's native skill loader remains the source of truth for `SKILL.md` loading. The project `skills/` directory is exposed through `resources_discover()` and project settings.

## Chosen Integration Points

### Task creation

`before_agent_start` creates one Neurofebric `Task` per user turn and advances it through `RECEIVED`, `UNDERSTANDING`, and `PLANNING`.

### Planning

When the model requests a tool, `tool_call` constructs a minimal structured `Plan` containing that tool call, validates it against the registered skills/tools, and advances the task through `PLAN_VALIDATION` and `EXECUTING`.

This first live planner is model-agnostic and observation-driven. A future model-backed planner can implement the existing `Planner` interface without changing the kernel.

### Policy

`tool_call` evaluates the mapped Pi tool through the kernel policy. `DENY` blocks the call. `REQUIRE_APPROVAL` is delegated to a clean approval provider; the current Pi UI implementation is only an adapter. Non-interactive approval fails closed.

### Tool execution

Pi executes the actual tool. The adapter does not invoke or reimplement `read`, `bash`, `write`, or other built-ins.

`tool_execution_end` supplies the result to the kernel for observation and validation. Tool failures are never converted into successful task results.

### Validation and recovery

After a tool result, the adapter moves the task through `OBSERVING` and `VALIDATING`. Failed validation enters `RECOVERING`; the bounded recovery policy decides whether to retry, replan, escalate, or terminate. The first integration records the decision and does not create uncontrolled parallel execution.

### Persistence and trace

Structured task and event summaries are persisted through `appendEntry()` as custom session entries. Trace data is bounded and redacted. Full prompts, credentials, and raw sensitive tool payloads are not persisted by the adapter.

### Cancellation and timeout

Pi's `AbortSignal` is used where an extension API provides one. Task state, deadlines, step timeouts, and tool timeouts remain kernel concerns. The adapter must check task state before recording or approving a new operation.

## Non-Goals

This integration does not:

- create a second model call loop;
- call OmniRoute directly;
- replace Pi's built-in tools;
- implement domain-specific planners;
- implement parallel sub-agents;
- add a database or vector store;
- build a fake approval system.

## Adapter Layout

```text
platform/pi/
  kernel-adapter.ts   Pi-independent task/lifecycle bridge
  tool-adapter.ts     Pi tool metadata to kernel descriptors
  approval.ts         generic approval provider boundary
```

The extension binds these adapters to Pi lifecycle events. The kernel remains independently testable with deterministic fakes.

## Current Limitations

The first live planner derives a one-step plan from the model's observed tool call. It does not yet ask the model for a complete multi-step plan. Structured model-output parsing, durable task storage, full integration tests, and parallel execution remain follow-up work.
