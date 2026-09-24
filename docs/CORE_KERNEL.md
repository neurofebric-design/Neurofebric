# Core Kernel

## Purpose

The core kernel is a domain-agnostic coordination layer around Pi. It owns task state, plans, capability selection, policy decisions, execution records, validation, recovery, context assembly, memory access, events, artifacts, and provenance.

Pi remains responsible for the actual model conversation, context/session persistence, compaction, provider streaming, model retries, built-in tools, and tool-call execution.

## Boundaries

The kernel must not:

- parse OmniRoute-specific responses;
- contain domain branches for files, databases, Splunk, SQL, or APIs;
- replace Pi's agent loop;
- silently reinterpret tool errors as successful text;
- execute an unregistered or unvalidated plan;
- bypass policy for retries;
- persist unredacted secrets or full sensitive payloads.

## Task Lifecycle

```text
RECEIVED
  -> UNDERSTANDING
  -> PLANNING
  -> PLAN_VALIDATION
  -> EXECUTING
  -> OBSERVING
  -> VALIDATING
  -> COMPLETED
```

Recovery paths are explicit:

```text
EXECUTING -> RECOVERING -> RETRYING -> EXECUTING
VALIDATING -> RECOVERING -> REPLANNING -> PLAN_VALIDATION
RECOVERING -> ESCALATED
```

`FAILED`, `CANCELLED`, `TIMEOUT`, and `COMPLETED` are terminal for normal execution. Every transition is checked by a pure state-machine function.

## Planning

A plan is a dependency graph of typed steps. Each step declares its skill, tools, dependencies, expected output, validation criteria, retry policy, timeout, and status. Plan validation rejects missing skills/tools, missing output criteria, unknown dependencies, duplicate IDs, and cycles before execution.

The kernel exposes a `Planner` interface. Pi or another model adapter may implement it, but the kernel does not prescribe a model or prompt format.

## Execution

`executeTool()` wraps a tool runner and returns a universal `ToolResult` containing data, metadata, artifacts, warnings, errors, provenance, and an execution record. Failures throw a typed `CoreError` with the execution record attached.

The first implementation exposes interfaces only. Pi's tool runtime remains the actual execution adapter for built-in and registered tools.

## Recovery

Recovery is bounded by retry, replan, depth, and execution-time limits. Non-idempotent or unknown side-effecting operations are not automatically retried. Recovery can escalate or terminate rather than loop indefinitely.

## Context and Memory

Context sources are prioritized and bounded before inclusion. Memory is accessed through `MemoryStore` with explicit `SESSION`, `PROJECT`, and `LONG_TERM` scopes. The initial store is in-memory and is not a durable production store.

## Observability and Provenance

`EventBus` provides structured event records with task and correlation IDs. Provenance links evidence to executions and artifacts. The Pi adapter should persist bounded, redacted summaries through Pi session entries rather than logging complete prompts or tool payloads.
