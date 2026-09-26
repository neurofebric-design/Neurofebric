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
| `denied_content_patterns` (case-insensitive substring over all args) | Step 4: joins `args.values()` and substring-matches | **Split into three scoped fields** — `destructiveCommandPatterns` (substring, command text), `destructiveCommandTokens` (whole-token, command text, the deletion guard), and `secretWritePatterns` (write payloads only) | ⚠️ deliberately narrowed and completed, see below |
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
4. **Content patterns now match arguments, not file contents.** Narrowed further
   than the legacy engine: the patterns are split by scope
   (`destructiveCommandPatterns` for command text, `destructiveCommandTokens` for
   the deletion guard, `secretWritePatterns` for write payloads), because matching
   all patterns against all arguments blocked `grep` for `password` and therefore
   blocked credential analysis entirely. This is a deliberate correctness fix, not a
   faithful port.

## Content pattern scoping (deliberate divergence from the legacy engine)

The legacy engine matched every pattern against **every argument value** of every
tool call. That is a single rule doing two unrelated jobs, and it caused a live
usability bug: with `password` in the list, a `grep` whose `pattern` argument was
`password` was denied, so the file-analysis and log-analysis skills could not
investigate credential handling in a file at all. The rules are now scoped to
the payload each one is actually about.

| Config field | Matched against | Applies to |
| --- | --- | --- |
| `destructiveCommandPatterns` | **Command text only** — the `command`, `cmd`, `script`, `shell`, `shellCommand`, `args`, `argv` arguments; for a shell tool, the whole payload | Every tool tier |
| `destructiveCommandTokens` | **Command text only**, as whole tokens | Every tool tier |
| `secretWritePatterns` | **Content payload only** — the `content`, `contents`, `text`, `body`, `data`, `new_string`, `old_string` arguments | `riskLevel: WRITE` tools only |

Shipped values: destructive substrings are `rm -rf`, `format c:`; destructive
tokens are `rm`, `rmdir`, `del`, `erase`, `unlink`, `shred`, `remove-item`;
secret patterns are `api_key`, `password`, `secret`, `authorization`.

**Why destructive patterns span tiers.** They name operations that destroy
state, so a tier is the wrong axis: whether a command runs is a property of the
command, not of which tool happened to carry it. They are still matched against
command text only, so *documenting* a destructive command in a report or a
runbook is not an operation and is allowed.

**Why secret patterns are write-only.** A secret must not be *persisted*.
Reading or searching for one is ordinary analysis. Matching these against a
`grep` pattern or a `read` path would block the exact work the analysis skills
exist to do.

**Three exclusions are load-bearing and each has a test:**

1. **Read and search arguments are never matched** against `secretWritePatterns`.
   `grep` for `password`, `read` of `docs/secret-handling.md`, and
   `find` for `*.env` are all allowed.
2. **The path argument is never matched**, even for writes. A file named
   `password-policy.md` is not a secret, and a write whose content is clean to
   that path is allowed. Only the content it would persist is judged.
3. **File content is never matched against destructive patterns.** A runbook
   that quotes a recursive delete is documentation.

**Interaction with the pre-existing controls.** Path-based credential rules in
`platform/core/policy.ts` (`SECRET_ACCESS_PATTERNS`, `sensitiveBasenameMatch`)
are separate and unchanged. They still deny an operation aimed at a file or
directory literally named `secrets`, `.env`, `id_rsa`, and so on — including a
read or a `ls`. That is a *path* control, not a content-scope control, and the
two are asserted separately in the tests so they are never conflated.

**Migration.** The old `deniedContentPatterns` key is a hard validation error
that names both replacements. An operator who upgrades gets a loud failure at
session start rather than a silently inert rule they believe is still enforcing.

## The deletion guard: shell must not bypass deletion control

**The rule.** A command that invokes a destructive program is denied at every
tool tier, whatever flags it carries: `rm`, `rm -f`, `rm -rf`, `rm -r -f`,
`rm -fr`, and plain `rm file` are all the same decision. The same holds for
`rmdir`, `del`, `erase`, `unlink`, `shred`, and `Remove-Item`.

**Why it is a rule and not an accident.** `bash` is a *permitted* tool, and the
Pi integration has no separate denied delete tool. A deletion performed through
the shell is therefore reachable no matter which tool names it, so the only
place it can be stopped is the command itself. An earlier version relied on the
substring `rm -rf`, which happened to also catch `rm -f` — correct by luck, and
blind to plain `rm file`. The guard is now expressed as **whole-token matching**
in `destructiveCommandTokens`, so it is complete by construction and a word that
merely contains a program name is not caught by accident (`echo charm` and
`node confirm.js` are allowed).

**Scope boundary.** The guard, like the other command-scope rules, applies to
command text only. A write whose payload merely *contains* the string `rm -rf`
is **allowed**, because documenting a command in a runbook or a report is not
running it. Injected content is still caught, because it arrives inside command
text: `bash -c "rm -rf /"` and `echo "rm -rf x" | sh` are both denied.

**Scratch cleanup.** When this guard refuses a deletion, the correct response is
to **overwrite or leave the file, never to delete it**. This is not a
theoretical restriction: it is why the report-writer skill writes to a new path
rather than clearing an old one, and why the log-analysis skill never tidies up
after itself. If a task genuinely cannot proceed without a deletion, that is a
signal that the workflow needs redesigning, not that the guard should be
loosened.

**Guardrail, not a sandbox.** This list cannot constrain what an already-permitted
command does, cannot prevent a deletion performed by a program that reads a
script, and is not a substitute for OS-level isolation. Path allowlisting,
secret isolation, and OS-level sandboxing remain deferred work; see
`docs/SECURITY.md`. Treat this list as a cheap, high-value tripwire, not as the
security boundary itself.

## Ordering guarantee

`ConfiguredPolicy.evaluate` runs in the legacy order, and a denial at any step stops
evaluation:

1. `deniedTools`
2. `allowedTools` (when non-empty)
3. limits — tool calls per task, then file writes per task
4. `destructiveCommandPatterns`, against command text
5. `destructiveCommandTokens` (the deletion guard), against command text
6. `secretWritePatterns`, against write-tier content payloads
7. path containment (`WorkspaceBoundary`) and `fileRules`
8. `maxBytesPerWrite`

Only if all eight pass are the counters incremented and the request handed to the
tier policy (`DefaultPolicy` in `APPROVAL` mode, `TrustedProjectPolicy` in
`TRUSTED_PROJECT` mode), which is what turns a write into `REQUIRE_APPROVAL` or
resolves trusted-mode writes to `ALLOW`. The declarative rules can remove a
permission; they can never add one.
