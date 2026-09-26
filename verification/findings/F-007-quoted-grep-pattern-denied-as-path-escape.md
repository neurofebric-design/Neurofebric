# Finding F-007: Quoted backslash-leading grep pattern misclassified as rooted path; the denial terminates the task

- **ID:** F-007
- **Status:** Open (observed live 2026-09-26)
- **Component:** Path-boundary precheck (path-escape guard), policy violation handling (see F-003), denial message diagnostics

## Description
This shell command was denied in precheck without executing (Took 0.0s):

    find . -type f -name "*.jsonl" -o -name "*.log" | grep -v "node_modules" | grep -v "\.git"

    policy neurofebric-policy.json: path boundary violation: \.git: path escapes the allowed root (C:\Users\Rishabh Sharma\.pi\agent)

The guard extracted `\.git` — a grep EXCLUSION PATTERN, not a path operand —
from the quoted pattern. A backslash-leading token resolves as a rooted path;
drive-relative resolution places it outside any allowed root, so the whole
command is denied. The committed suite already tests that grep patterns are not
path operands; this shape (quoted, backslash-leading) defeats that heuristic.

## Secondary issues
1. **The denial killed the task (F-003 reproduced live):** immediately after
   this single denial, every tool call returned "Task is FAILED; no further
   tool calls are accepted". A false-positive boundary violation terminated an
   otherwise healthy session — exactly the behavior F-003 predicts.
2. **Denial message diagnostics:** the message shows only the policy file
   basename and one allowed root — not the full root list, the raw token's
   origin, or the extraction rule that produced it. The false positive cannot
   be diagnosed from the message alone. (Feeds P3a structured violations.)

## Expected behavior
- Path extraction must not treat quoted grep/sed pattern arguments as path
  operands; extend the existing grep-pattern test with this shape.
- Per F-003, a boundary violation should deny the call, not terminate the task.
- Violation messages should carry the full allowed-roots list, the raw token,
  and the rule that produced it.