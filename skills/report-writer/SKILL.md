---
name: report-writer
description: Persist analysis findings from file-analysis, log-analysis, or structured-data into a structured Markdown report file. Use when a user asks to save, write, persist, export, or file away findings, results, or a summary produced earlier in the conversation.
version: 1.0.0
capabilities:
  - report-authoring
  - finding-persistence
  - evidence-synthesis
supportedInputs:
  - text/plain
  - application/json
supportedOutputs:
  - text/markdown
requiredTools:
  - write
optionalTools:
  - read
dependencies:
  - file-analysis
  - log-analysis
  - structured-data
constraints:
  - write only under the project workspace
  - never overwrite an existing file without explicit confirmation
  - never write credentials, tokens, or raw secret values into a report
  - keep the report bounded; no unbounded dumps
risk: write
examples:
  - save these log findings to reports/incident-2024-05-06.md
---

# Report Writer

## Purpose

Turn findings already established in this conversation into a durable, structured
Markdown report at a path the user chose.

## Capabilities

- assemble findings into a consistent report structure;
- preserve evidence references (file paths, line numbers, counts) verbatim;
- mark observations separately from hypotheses and from limitations;
- write the report to an explicit path inside the project workspace;
- read the file back to verify the write actually landed.

## When to Use

Use this skill when the user asks to save, write, persist, export, or file away
findings, results, or a summary — for example "write this up", "save that to
`reports/incident.md`", or "put the analysis in a file".

## When Not to Use

- The user wants the answer in the conversation only, with no file written. Just answer.
- The user wants a source file, configuration, or dataset modified. That is a
  different change with different risk and review needs; do not route it through here.
- There are no findings yet. Run the analysis skill first; this skill records results,
  it does not produce them.
- The content is a log, a CSV, or a JSON file that already exists as the artifact. Point
  the user at the file instead of copying it.

## Required Tools

Pi built-in `write` to create the report, and Pi built-in `read` to read it back and
verify the contents. No other tool is needed; anything else is scope creep.

## Inputs

- the target report path, or enough intent to propose one;
- the findings to persist, including their evidence references;
- optional constraints: audience, template, redaction rules, whether to overwrite.

## Outputs

- the confirmed report path;
- the report structure written, with sections for summary, evidence, findings,
  limitations, and next actions;
- a verification result confirming the file exists and matches what was intended;
- nothing else. This skill does not produce analysis.

## Workflow

1. Confirm the target path resolves inside the project workspace. If it resolves
   outside, stop and say so rather than writing.
2. Check whether the file already exists. If it does, ask the user to confirm the
   overwrite; never silently replace an existing report.
3. If the path or the scope of the report is ambiguous, propose a path and a section
   list and get a yes before writing.
4. Write the report with Pi's `write`: summary, scope and inputs, findings ordered by
   severity with evidence, hypotheses, limitations, next actions.
5. Read the file back with `read` and verify the sections and evidence references
   survived the write.
6. Report the path and what was written.

## Constraints

- Write only under the project workspace. A path outside it is refused, not prompted for.
- Never overwrite an existing file without explicit confirmation for that file.
- Never write credentials, tokens, keys, or raw secret values into a report. Reference
  the location and redact the value; a report is a durable artifact and outlives the run.
- Keep the report bounded: link to evidence, do not paste whole files or datasets.
- Preserve the distinction between an observation and a hypothesis. Do not upgrade a
  hypothesis to a finding while writing.
- Do not modify anything other than the single report file.

## Example

User: "Save the log findings to `reports/incident-2024-05-06.md`."

1. Confirm `reports/incident-2024-05-06.md` is inside the project workspace; it is.
2. Check whether it exists; it does not, so no overwrite confirmation is needed.
3. Write: summary, scope, the severity counts, the burst at lines 214-227, the pool
   warning at line 205 as a hypothesis, and limitations.
4. `read` the file back and confirm every section and line reference is present.
5. Report the path and the section list.
