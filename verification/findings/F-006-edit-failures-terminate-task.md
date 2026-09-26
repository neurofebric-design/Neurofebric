# Finding F-006: Consecutive edit failures terminate the task before strategy can change

## ID: F-006

### Status
Open (observed live 2026-09-26 during the first D-007 docs attempt)

### Component
Recovery/limits (maxStepRetries, maxToolRetries), edit tooling, trace diagnostics

### Description
Two edit calls failed atomically with "Could not find the exact text" (no changes applied — docs/handoff.md and docs/DECISIONS.md). Immediately after, every tool call returned "Task is FAILED; no further tool calls are accepted". Hypothesis: the recovery budget (CoreLimits maxStepRetries = 1, maxToolRetries = 2) was exhausted by the two failures, terminating the task before the agent could change strategy — e.g. re‑reading the exact bytes, or rewriting the file wholesale. Trace evidence: not yet read (operator will supply out‑of‑band); mechanism unconfirmed.

### Impact
Bounded recovery is intentional and tested, but the boundary currently sits at "same strategy, another attempt". A deterministic failure mode (exact‑match edit vs CRLF/whitespace mismatch on Windows) can consume the entire budget with zero probability of success on retry, killing an otherwise healthy task.

### Expected behavior
Either recovery distinguishes "same failing call retried" from "new strategy attempted", or repeated same‑class tool failures admit a replan (maxReplans) instead of terminal failure. At minimum the trace must record a structured reason for the task failure (feeds P3a).

### Related
F-007 (a second task death the same day, via policy‑denial termination — different mechanism).