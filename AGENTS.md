# Pi Analysis Project Guidance

## Scope

This workspace contains the existing Python agent harness. Pi should be treated as the primary general-purpose agent runtime; do not recreate its agent loop, LLM client, or basic filesystem tools inside this repository.

## Operating rules

- Use Pi's built-in `read`, `bash`, `grep`, `find`, and `ls` capabilities for analysis.
- Use the skills in the user `.agents/skills` directory for file, log, CSV, JSON, and report workflows.
- Prefer bounded searches and parsers over loading large files into the model context.
- Keep credentials, tokens, and personal data out of reports and logs.
- Record durable project decisions in `memory/`; do not add a vector database without a concrete retrieval requirement.

## Planned connectors

Database, Splunk, and external API connectors are intentionally deferred until the local file and shell workflow is verified. Add them as focused Pi extensions with explicit read-only or confirmation boundaries.
