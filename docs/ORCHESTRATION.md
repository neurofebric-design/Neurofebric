# Orchestration

## Request Flow

```text
User request
  -> Pi before_agent_start
  -> task creation
  -> objective and constraints
  -> structured planner
  -> plan validation
  -> capability-oriented skill selection
  -> tool selection
  -> policy decision
  -> Pi tool execution
  -> structured result
  -> validator
  -> success or bounded recovery
  -> finalizer
  -> provenance and response
```

Pi owns the actual conversation and model turns. The platform adapter supplies kernel state and observes lifecycle events. The model may propose structured plans or tool calls, but the kernel validates them before execution.

## Selection

Skills advertise capabilities and tool requirements. Candidate skills are selected by capability compatibility, not only keyword matching. Multiple skills may be selected when their capabilities are compatible.

Tools are selected from a registry or Pi's active tool catalog and must have a descriptor containing permissions, risk, timeout, retry policy, idempotency, and side-effect classification.

## Policy

Every tool invocation must have a policy decision: `ALLOW`, `DENY`, or `REQUIRE_APPROVAL`. Approval is an injected interface. Pi UI is one adapter; non-interactive runs fail closed for operations requiring approval.

## Recovery

A failed tool result is classified before a recovery strategy is selected. Successful prior steps and observations are included in replanning input. A planner must not discard completed work without an explicit reason.

## Parallelism

The plan model supports dependency branches, but the first executor remains sequential and bounded by `maxParallelTasks` and `maxParallelTools`. No uncontrolled fan-out is introduced.

## Pi Mapping

| Kernel concern | Pi integration |
| --- | --- |
| Agent lifecycle | `before_agent_start`, `agent_start`, `agent_end`, `agent_settled` |
| Context | `context` and `context_with_system` |
| Tools | `tool_call`, `tool_execution_start`, `tool_execution_end` |
| Session state | `appendEntry()` and session branch APIs |
| Skills | `resources_discover` plus native `SKILL.md` loading |
| Approval | `ctx.ui.confirm()` or `ctx.ui.select()` |
| Model calls | Pi provider/session APIs, never direct OmniRoute calls |
