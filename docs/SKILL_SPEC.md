# Skill Specification

## Purpose

A skill is a reusable reasoning and workflow description. It tells Pi when a capability is relevant, what procedure to follow, which tools may be needed, and what result to produce. It does not implement deterministic operations.

## Directory Shape

```text
skills/
  README.md
  <skill-name>/
    SKILL.md
    instructions/
      <optional detail files>
    examples/
      <optional examples>
    resources/
      <optional templates or reference data>
```

Only a directory containing `SKILL.md` is a skill. Supporting files are optional and should be referenced with paths relative to the skill directory.

## SKILL.md Frontmatter

Required fields:

```yaml
---
name: file-analysis
description: Inspect and analyze local files. Use when a user asks to understand a file, find patterns, or produce a file-based report.
---
```

Rules:

- `name` must be lowercase kebab-case and match the directory name.
- `description` must state both what the skill does and when it should be used.
- Keep routing metadata concise; detailed procedures belong in the body or linked files.
- Do not put credentials, tokens, private data, or environment-specific secrets in a skill.

## Required Sections

Each `SKILL.md` should define:

1. **Purpose**: the problem the skill solves.
2. **Capabilities**: concrete operations or questions it supports.
3. **When to use**: matching user intents and available inputs.
4. **When not to use**: boundaries and neighboring skills.
5. **Required tools**: built-in or custom tools the procedure may call.
6. **Inputs**: files, user-provided values, or prior results required.
7. **Outputs**: evidence, summaries, artifacts, or response shape.
8. **Workflow**: ordered procedure and decision points.
9. **Constraints**: safety, size, privacy, and reliability limits.
10. **Examples**: at least one minimal usage example.

## Runtime Contract

Pi handles discovery and lazy loading. The platform extension may validate and display the catalog, but it must not maintain a second hard-coded list of skills.

A skill may reference Pi built-in tools by name. A custom tool must be registered by a trusted Pi extension and should have a typed schema, bounded output, and explicit permission behavior.

## Adding a Skill

1. Create `skills/<skill-name>/SKILL.md`.
2. Add valid frontmatter with a specific routing description.
3. Document purpose, boundaries, inputs, outputs, tools, workflow, and constraints.
4. Add examples or resources only when they improve execution.
5. Run the project tests and verify the skill appears in Pi's discovery.
6. Do not modify the orchestrator for ordinary skill additions.

## Validation

The first phase validates skill metadata for the project catalog. Pi remains responsible for native discovery and loading. Invalid or incomplete skills should fail validation with an actionable message rather than silently entering the catalog.
