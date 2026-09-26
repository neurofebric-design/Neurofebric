# Policy Port: legacy Python harness → kernel

This is the mapping produced before any code was written for the policy port
(Task 4, Step 1). The legacy engine is `core/policy_engine.py`, configured by
`policies/default_policy.yaml`. The kernel mechanism is
`platform/core/configured-policy.ts`, configured by `.pi/neurofebric-policy.json`.

The legacy Python harness is **not** modified. This is a one-way port: the
declarative rules now live in the kernel, and the YAML file remains only as the
legacy reference implementation's own configuration.

## Mapping

| Legacy concept (`default_policy.yaml`) | Legacy behaviour (`policy_engine.check`) | Kernel mechanism | Clean? |
| --- | --- | --- | --- |
| `denied_tools` | Step 1: deny wins, checked first | `PolicyConfig.deniedTools`, evaluated before every other rule in `ConfiguredPolicy.evaluate` | ✅ |
| `allowed_tools` | Step 2: not on the list is a denial | `PolicyConfig.allowedTools`; **empty list means "no name-based gating"**, not "allow all" — the tool still has to clear the tier check in `policy.ts` | ⚠️ semantics differ, see below |
| deny beats allow | Deny is evaluated first, so it wins | Same ordering, pinned by a test | ✅ |
| `file_rules: workspace/** allow, ** deny`, first match wins | `_check_path` walks rules in order, returns on the first match, default deny | `PolicyConfig.fileRules` (ordered glob patterns) over the path relative to the configured root, first match wins, default deny | ✅ |
| `workspace` as a magic prefix | `workspace` meant `config.workspace_dir` | `WorkspaceBoundary` with explicit `allowedRoots`, plus symlink/junction-defeating realpath resolution the legacy version did not have | ✅ strictly stronger |
| `denied_content_patterns` (case-insensitive substring over all args) | Step 4: joins `args.values()` and substring-matches | `PolicyConfig.deniedContentPatterns`, case-insensitive substring over **every** string value in the input, nested, bounded depth | ✅ (broader: nested values are scanned too) |
| `limits.max_tool_calls_per_run: 40` | Step 3, counted per run, only on success | `limits.maxToolCallsPerTask`, counted per `taskId`, only on success | ⚠️ renamed: the kernel's unit is a task, not a run |
| `limits.max_file_writes_per_run: 10` | Counted on `write_file` only | `limits.maxFileWritesPerTask`, counted on any tool classified `riskLevel: WRITE` (so `edit` counts too) | ✅ broader |
| `limits.max_bytes_per_write: 2000000` | Step 6, `len(content.encode("utf-8"))` | `limits.maxBytesPerWrite`, measured as UTF-8 bytes of the write payload | ✅ |
| `on_violation: block` | Deny the action, tell the agent, let it try again | `onViolation: "block"` → the decision is `DENY`; the kernel marks the call denied and the task keeps running | ✅ |
| `on_violation: abort` | Kill the whole run immediately | `onViolation: "abort"` → the decision carries `violation: "abort"`; `KernelAdapter.precheckToolCall` transitions the task to `FAILED`, emits `POLICY_VIOLATION` + `TASK_FAILED`, and every later tool call is refused | ✅ |
| decision log (`_log_event`) | appended to an in-memory audit log | `EventBus`, which redacts payloads by construction before they reach `appendEntry` | ✅ strictly stronger |
| nothing equivalent | — | Pi built-in tool **risk tier** (`platform/pi/tool-adapter.ts` → `policy.ts`) is a *separate*, additive control the legacy engine never had. Declarative rules run **in addition to** it, never instead of it | ✅ additive |

## Things that do not map cleanly

1. **`allowed_tools` naming.** The legacy list named Python tools (`read_file`,
   `write_file`). The kernel's tools are Pi's built-ins (`read`, `write`, `bash`, …),
   which Pi registers dynamically at session start. A hard-coded allow list would
   break every future tool, so an empty `allowedTools` means "no name-based gating"
   and the tool's risk tier still decides. The shipped config therefore relies on
   tiers plus the rules below. A non-empty list is still honoured when you want it.
2. **YAML.** The legacy file is YAML and the repo has no YAML parser dependency in
   the Node path. The kernel config is JSON, consistent with `.pi/neurofebric.json`,
   so it needs no parser and cannot be mis-parsed. This is a deliberate format
   divergence, not a port of the file itself.
3. **Per-run → per-task.** Pi owns "the run"; the kernel's unit of accounting is the
   `Task` it creates per user turn. Limits are therefore per task.
4. **Content patterns apply to arguments, not file contents.** A `grep` whose
   `pattern` argument is `password` is denied by the shipped config, because the
   legacy engine also matched arguments. This is faithful but surprising; it is
   called out in the config file and is a one-line change to relax.

## Ordering guarantee

`ConfiguredPolicy.evaluate` runs in the legacy order, and a denial at any step stops
evaluation:

1. `deniedTools`
2. `allowedTools` (when non-empty)
3. limits — tool calls per task, then file writes per task
4. `deniedContentPatterns`
5. path containment (`WorkspaceBoundary`) and `fileRules`
6. `maxBytesPerWrite`

Only if all six pass are the counters incremented and the request handed to the
tier policy (`DefaultPolicy` in `APPROVAL` mode, `TrustedProjectPolicy` in
`TRUSTED_PROJECT` mode), which is what turns a write into `REQUIRE_APPROVAL` or
resolves trusted-mode writes to `ALLOW`. The declarative rules can remove a
permission; they can never add one.
