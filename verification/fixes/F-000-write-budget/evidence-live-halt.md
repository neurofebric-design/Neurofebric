# Live Halt Evidence - 2026-09-26 (updated with full transcript)

Pi halted during F-000 resume. Chain of events from scrollback:

1. Wrote + committed F-002 finding (commit 40d4e2b on main). DONE.
2. Secret scan (grep sk-|api_key|Bearer|password|secret) -> exit 1, no matches. CLEAN.
3. Attempted: mkdir -p ../_session-archive && mv add_claude_bridge.js update_settings.js analyze_records.py ../_session-archive/
   REJECTED: "policy neurofebric-policy.json: path boundary violation:
   ../_session-archive: path escapes the allowed root"
4. Task then transitioned to FAILED: "Task is FAILED; no further tool calls are accepted"
   All tools (bash, ls, read, pi) refused from that point.

FINDINGS:
- F-003: A single policy violation escalates to terminal task-FAILED (no recovery).
        Fail-closed should reject the one call, not kill the whole session.
- F-004: Archive target ../_session-archive is outside the policy root and is
        structurally unreachable. Archive must live inside the root.
