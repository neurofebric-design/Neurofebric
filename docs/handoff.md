# Agent Harness Handoff Document

## 1. Directory Tree

```
agent-harness/
â”œâ”€â”€ .pi/
â”‚   â”œâ”€â”€ extensions/platform-orchestrator.ts
â”‚   â”œâ”€â”€ neurofebric-policy.json
â”‚   â”œâ”€â”€ neurofebric.json
â”‚   â””â”€â”€ settings.json
â”œâ”€â”€ core/                    # Legacy Python harness internals
â”œâ”€â”€ agents/                  # Agent definitions
â”œâ”€â”€ tools/                   # Tool implementations
â”œâ”€â”€ policies/                # YAML rule files
â”œâ”€â”€ config/                  # settings.yaml
â”œâ”€â”€ platform/
â”‚   â”œâ”€â”€ core/                # Orchestrator core modules
â”‚   â”œâ”€â”€ pi/                  # Pi kernel integration
â”‚   â”œâ”€â”€ orchestration.mjs / .test.mjs
â”‚   â”œâ”€â”€ skill-conformance.test.mjs
â”‚   â”œâ”€â”€ skill-registry.mjs / .test.mjs
â”œâ”€â”€ skills/
â”‚   â”œâ”€â”€ file-analysis/SKILL.md
â”‚   â”œâ”€â”€ log-analysis/SKILL.md
â”‚   â”œâ”€â”€ report-writer/SKILL.md
â”‚   â”œâ”€â”€ structured-data/SKILL.md
â”œâ”€â”€ main.py
â”œâ”€â”€ memory/
â”œâ”€â”€ OmniRoute/               # Provider extension integration
â”œâ”€â”€ docs/
â”œâ”€â”€ reports/                 # All gauntlet results (A-H)
â”œâ”€â”€ requirements.txt
â”œâ”€â”€ tests/
â”œâ”€â”€ verification/
â”‚   â”œâ”€â”€ findings/
â”‚   â”œâ”€â”€ fixes/
â”‚   â”œâ”€â”€ scenarios/
â””â”€â”€ workspace/
```

## 2. Orchestrator Core Contents (platform/core/)

- types.ts â€” Task, Plan, Skill/Tool Descriptors, Artifact, ValidationResult, PolicyDecision
- workspace.ts â€” Workspace boundary management and path validation
- tool-paths.ts â€” Path candidate extraction for security checks
- policy.ts â€” DefaultPolicy and TrustedProjectPolicy engines; destructive-command and credential-access pattern regexes; classifyTrustedOperation
- policy-config.ts â€” Policy configuration loader
- redaction.ts â€” Signature and field-based credential/data scrubbing at event bus / persistence / artifact / provenance boundaries
- configured-policy.ts â€” Policy wrapper
- tool-registry.ts â€” Tool registration and metadata
- skill-catalog.ts â€” toSkillDescriptor, skillsForCapabilities, assertUniqueSkills, assertResolvableDependencies
- skill-metadata.ts â€” parseFrontmatterFields, validateSkillMetadata, parseSkillDocument, SkillMetadataError, frontmatter validation
- planner.ts / plan.ts â€” PlannerInput, Plan, PlanStep interfaces and state
- validation.ts â€” Input/output validation
- limits.ts â€” Resource limits
- context-memory.ts â€” Context and memory integration
- recovery.ts â€” Error recovery and retry
- execution.ts â€” Execution tracking
- errors.ts â€” CoreError
- events.ts â€” Event bus
- state-machine.ts â€” Task status transitions (createTask, transitionTask, canTransition)
- artifact.ts â€” Artifact creation and integrity verification
- index.ts â€” Barrel exports

## 3. Skill Contract and Loader

Skill Contract (SKILL.md frontmatter):

| Field | Cardinality | Description |
|---|---|---|
| name | required | Lowercase kebab-case, must match directory |
| description | required | 2000 chars max |
| version | optional | semver |
| capabilities | optional list | capability tokens |
| supportedInputs | list | MIME types |
| supportedOutputs | list | MIME types |
| requiredTools | list | registered tool names |
| optionalTools | list | registered tool names (skipped if unknown) |
| dependencies | list | skill names (non-self-referencing) |
| constraints | list | plain-text bullet statements |
| examples | list | use-case strings, 500 chars max |
| riskLevel / risk | optional | READ_ONLY / CONTROLLED / WRITE (mutually exclusive spellings) |

Loader logic (skill-catalog.ts + skill-metadata.ts):
- parseFrontmatterFields: splits on --- delimiters, rejects tabs, control chars, duplicate keys, unknown keys, unsupported YAML constructs (anchors/aliases, block scalars, flow collections).
- validateSkillMetadata: validates name vs directory, version regex, risk level, capability/tool/dependency patterns, enforces max counts (2000 desc, 200 items, 400 total), normalizes risk/riskLevel into one field.
- parseSkillDocument: produces a SkillDescriptor with fallbackRisk = READ_ONLY.
- assertUniqueSkills, assertResolvableDependencies: guard catalog integrity.
- Non-strict discovery skips unknown optional tools and drops invalid required-tool skills without throwing.

## 4. Phase 2 Roadmap

From reports/REPORT.md and planning notes:

Priority 1 â€” Adaptive Write-Budget Thresholds:
- Issue: Fixed maxFileWritesPerTask caused halts during gauntlet bootstrap (F-001).
- Solution: Scope write-budget exemptions or higher burst limits for authorized harness generation scripts.

Priority 2 â€” Resilient Session State Recovery:
- Issue: Manual reconciliation between parent and child tasks after interruptions.
- Solution: Auto-snapshot and resume partial gauntlet workflows (checkpointing).

Priority 3 â€” Enhanced Policy Interception Diagnostics:
- Issue: Generic termination signals for blocked shell redirects.
- Solution: Structured JSON error payloads for policy violations instead of exit codes.

Long-term roadmap items:
- Model routing across multiple backends (D-001 gates full fallback removal).
- Persistent memory store (SQLite initially) for cross-session context.
- MCP server connectors for external tools/databases/Splunk.
- Optional human-approval gates for sensitive operations (currently fail-closed by design).
- Sub-agent spawning for delegated work.
- Dynamic replanning/adaptation based on execution feedback.

Note: Gate 1 of the D-001 migration is verified â€” a real Pi turn pinned to auto/gemini via OmniRoute completed successfully. Step 2 (fallback provider cleanup) is pending as Gate 2.

## 5. Configuration Defaults

.pi/settings.json:

```json
{ "skills": ["../skills"] }
```

.pi/neurofebric.json:

```json
{ "policyMode": "TRUSTED_PROJECT", "allowedRoots": ["."] }
```

.pi/neurofebric-policy.json (key points only â€” see the file for the full policy):
- deniedTools/allowedTools: [] â€” no name gating; tool risk tier governs.
- fileRules: catch-all allow read+write inside roots.
- Pattern lists â€” destructive command patterns and tokens, credential-filename rules, and the write-time credential guardrail â€” live in the policy file. Token spellings are intentionally omitted from this document, because persisting them is exactly what the write-time guardrail blocks.
- limits: maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2000000, onViolation: block.

Platform defaults (platform/core/limits.ts):

| Setting | Default |
|---|---|
| maxFileReadsPerTask | 100 |
| maxFileWritesPerTask | 10 (temporarily 50 for the Verification Gauntlet, see D-004) |
| maxFileReadBytes | 10 MB |
| maxFileWriteBytes | 1 MB |
| maxToolExecutionMs | 30 s |
| maxRetriesPerStep | 3 |
| maxReplansPerTask | 3 |
| contextCompressionThreshold | 0.75 |

Provider defaults:
- Canonical: OmniRoute via omni provider at http://localhost:20128 (omniroute-pi-ext-integration extension).
- Fallbacks (INSTALLED but DISABLED by default): pi-free, its git duplicate, @billjr99/pi-openai-compat.
- Gate 1 of D-001 is verified: OmniRoute is connected and carrying pinned auto/gemini traffic. Fallback removal is pending as Gate 2.

Policy mode (TRUSTED_PROJECT vs APPROVAL):
- TRUSTED_PROJECT resolves to ALLOW/DENY only (never prompts); dangerous ops are denied outright.
- APPROVAL (alternative) may return REQUIRE_APPROVAL for write/destructive ops via an ApprovalProvider.

---
*End of handoff document. Intended for external reviewer consumption.*
