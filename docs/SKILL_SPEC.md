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


## Metadata Is Descriptive, Never Permissive

A skill declares what it *needs* and what it *supports*. It never grants a permission. A skill whose frontmatter lists a tool is a statement about that skill's requirements, not a request that be granted, and not a capability the runtime will honour on the skill's say-so.

The enforcement lives in `platform/core/policy.ts`, which classifies the actual tool call. `platform/core/skill-metadata.ts` produces descriptors that the kernel uses only to label plan steps and answer capability lookups. There is deliberately no code path from a skill descriptor to a policy decision, and a test in `platform/core/skill-metadata.test.ts` pins that invariant: a skill declaring a shell tool does not make a destructive shell command permitted.


## Full Frontmatter Schema

Thirteen fields are accepted, matching `SkillDescriptor` exactly. Any other key is a hard error, which is what makes attempts to smuggle in a permission field fail closed rather than being ignored.

| Field | Shape | Default | Notes |
| --- | --- | --- | --- |
| `name` | kebab-case string | required | Must match the containing directory |
| `description` | string | required | What it does and when to use it |
| `version` | semantic version | `0.0.0` | Validated when present |
| `capabilities` | list of identifiers | empty | Must be unique |
| `supportedInputs` | list of type tokens | empty | Types such as `text/plain`, never paths |
| `supportedOutputs` | list of type tokens | empty | Types, never paths |
| `requiredTools` | list of tool names | empty | Unknown tool names are rejected |
| `optionalTools` | list of tool names | empty | Disjoint from `requiredTools` |
| `dependencies` | list of skill names | empty | Must resolve within the catalog |
| `constraints` | list of strings | empty | Advisory text, not enforced limits |
| `risk` | `read`, `controlled`, `write` | `read` | The risk tier of what the skill may do; there is no `destructive` tier for a skill |
| `riskLevel` | `READ_ONLY`, `CONTROLLED`, `WRITE` | `READ_ONLY` | The same classification in the kernel's spelling |
| `examples` | list of strings | empty | Short usage hints |

`risk` and `riskLevel` are two spellings of ONE field. Declaring both is an error, not
a precedence rule. `risk: read` normalises to `riskLevel: READ_ONLY`, `controlled` to
`CONTROLLED`, and `write` to `WRITE`; an absent declaration means read. The registry
exposes the result as `skillRiskLevel(skill)` so no caller reconstructs it. An unknown
value fails validation and names the accepted values.

The risk tier is a *label*: it is what `/platform` displays and what plan steps are
annotated with. It grants nothing. Enforcement stays in `platform/core/policy.ts`, which
classifies the actual tool call.

Everything is fail closed. Malformed YAML, a wrong field type, an empty name, a duplicate entry, an unknown tool, an invalid risk value, a malformed version, a value shaped like a path, a self-dependency, an unresolvable dependency, or an unknown key all cause the skill to be rejected. A rejected skill stops discovery rather than being partially loaded, and the rejection is reported with the offending file.


## Accepted YAML Subset

The parser is deliberately small rather than general, because the exotic parts of YAML are exactly the ambiguous ones. Supported: a key with a scalar value, a key followed by dash-prefixed block sequence items, comments, and single or double quoted scalars.

Refused: tabs, anchors, aliases, tags, directives, block scalars, flow collections, nested mappings, and duplicate keys. There is no YAML library dependency, so the accepted grammar is exactly what this parser implements.


## Where These Rules Are Enforced

- Parsing and validation: `platform/core/skill-metadata.ts`
- Discovery and catalog assembly: `platform/skill-registry.mjs`
- Descriptor shaping and capability lookup: `platform/core/skill-catalog.ts`
- Authoritative safety decisions: `platform/core/policy.ts`
- Tests: `platform/core/skill-metadata.test.ts` and `platform/skill-registry.test.mjs`

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
4. Add an `examples/` fixture. `platform/skill-conformance.test.mjs` fails the build
   when a skill is missing one, or missing any of the ten required sections.
5. Declare `risk` only when the skill genuinely writes or executes; the default is `read`.
6. Run the project tests and verify the skill appears in Pi's discovery.
7. Do not modify the orchestrator for ordinary skill additions.

## Validation

The first phase validates skill metadata for the project catalog. Pi remains responsible for native discovery and loading. Invalid or incomplete skills should fail validation with an actionable message rather than silently entering the catalog.
