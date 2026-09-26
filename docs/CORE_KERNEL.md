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

Any active state may transition to `FAILED`, which is what makes a policy abort possible: see [Policy](#policy).

## Policy

Policy is declarative and lives in a config file, not in code and not in the extension. `platform/core/configured-policy.ts` evaluates it in a fixed order and **a denial stops evaluation**; the tier policy in `platform/core/policy.ts` runs afterwards and owns approval. The ordering guarantee is that **the declarative rules can remove a permission but never add one** — no config file can turn a write into an automatic approval.

Two behaviours are load-bearing and are easy to get wrong when reading the code:

- **`on_violation: abort` terminates the task.** A denial produced under `abort` carries `violation: "abort"`, and `KernelAdapter.precheckToolCall` transitions the task to `FAILED`, emits `POLICY_VIOLATION`, `POLICY_ABORTED` and `TASK_FAILED`, and refuses every subsequent tool call. `on_violation: block` (the default) denies only the call and leaves the task running.
- **Content patterns are scoped to the payload they are about.** `destructiveCommandPatterns` is matched against command text only, at every tool tier. `secretWritePatterns` is matched only against the content payload of a write-tier tool, never against a `grep` pattern or a `read` path. An unscoped match on all arguments blocks the very analysis the skills exist to perform. See [POLICY_PORT.md](POLICY_PORT.md) for the full mapping and the three exclusions that have tests.

## Planning

A plan is a dependency graph of typed steps. Each step declares its skill, tools, dependencies, expected output, validation criteria, retry policy, timeout, and status. Plan validation rejects missing skills/tools, missing output criteria, unknown dependencies, duplicate IDs, and cycles before execution.

The kernel exposes a `Planner` interface. Pi or another model adapter may implement it, but the kernel does not prescribe a model or prompt format.

## Execution and Artifacts

`executeTool()` wraps a tool runner and returns a universal `ToolResult` containing data, metadata, artifacts, warnings, errors, provenance, and an execution record. Failures throw a typed `CoreError` with the execution record attached.

The first implementation exposes interfaces only. Pi's tool runtime remains the actual execution adapter for built-in and registered tools.

On the live Pi path, artifacts are first-class:

- Whether a tool declares outputs is derived from its `sideEffect`/`riskLevel` classification, never from a list of tool names, so built-in, registered, and future remote/MCP tools behave identically.
- Read-only tools consume inputs and declare no outputs. A shell command is deliberately not inspected for candidate outputs, because guessing which paths a command produced would fabricate provenance.
- Every artifact starts `UNVERIFIED`. Trust is earned by a real filesystem check — existence, workspace containment, readability, non-emptiness, and a SHA-256 digest — never by being declared.

## Verification

Model completion is not task completion. `docs/TOOL_SPEC.md` requires that `success` is not inferred from a zero exit code or HTTP 200 alone, and the live adapter follows that rule:

| Situation | Outcome |
| --- | --- |
| Tool failed | `INVALID` (`pi-result`) |
| Tool succeeded, declared artifacts all verified | `VALID` (`artifact-verification`) |
| Tool succeeded, a declared artifact is missing/empty/corrupt/out of bounds | `INVALID` (`artifact-verification`) |
| Tool succeeded, a declared artifact cannot be judged | `INCONCLUSIVE` (`artifact-verification`) |
| Tool succeeded, no artifacts declared | `VALID` (`pi-result`) |

A task completes only when its **current attempt** has no unresolved failure. A superseded failure that recovery has legitimately retried does not block completion, while a failure in a sibling execution of the same attempt does. The artifact layer is generic: `classifyArtifactKind` is a lookup table that new capabilities extend with new media types.

## Recovery

Recovery is bounded by retry, replan, depth, and execution-time limits. Non-idempotent or unknown side-effecting operations are not automatically retried. Recovery can escalate or terminate rather than loop indefinitely.

## Context and Memory

Context sources are prioritized and bounded before inclusion. Memory is accessed through `MemoryStore` with explicit `SESSION`, `PROJECT`, and `LONG_TERM` scopes. The initial store is in-memory and is not a durable production store.

## Observability and Provenance

`EventBus` provides structured event records with task and correlation IDs. Provenance links evidence to executions and artifacts. The Pi adapter should persist bounded, redacted summaries through Pi session entries rather than logging complete prompts or tool payloads.

`ARTIFACT_VERIFIED` and `ARTIFACT_INVALID` events carry the artifact id, reference, kind, producer, task, step, and verification status, so a claim can be traced from a tool execution to a checked file. Provenance records only what is known: a reference is listed as an output locator when the tool was declared to write it, and a remote reference that cannot be checked locally is reported `UNVERIFIED` rather than assumed good.
