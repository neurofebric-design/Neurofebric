# Finding F-008: Tool-call budget exhausted by redundant reads; no low-budget telemetry

- **ID:** F-008
- **Status:** Open (observed live 2026-09-26 during the D-007 docs replay)
- **Component:** Limits telemetry (maxToolCallsPerTask), trace diagnostics, agent discipline

## Description
During a docs task, the agent re-read the same file region roughly 15-20 times
(offsets 138/118/130 repeatedly, whole-file reads x3) while locating an edit
anchor, consuming about half of the 40-call budget. The task then died at the
next call with "policy neurofebric-policy.json: maxToolCallsPerTask exceeded
(40)" — with both planned edits already applied but the third step and the
commit never reached. The counter counts calls, not progress, and the agent
received no signal about the remaining budget until the terminal denial.

## Impact
A task can die with its work half-done and uncommitted purely from wasted
reads. Unlike F-006 (retry exhaustion) this is not a tooling failure — the
budget did its job — but the harness gave the agent no chance to course-
correct: no low-budget warning, no signal that reads were being repeated.

## Expected behavior
- Surface remaining budget to the agent (e.g., a warning in tool results at
  75% and 90% of maxToolCallsPerTask) so degradation is graceful, not terminal.
- The trace should make repeated identical reads visible (feeds P3a).
- Agent-side mitigation (now a standing rule): never read the same region
  twice; plan the call sequence before starting.

## Related
F-006 (different exhaustion mechanism: edit-retry budget), F-003 (denial
handling).