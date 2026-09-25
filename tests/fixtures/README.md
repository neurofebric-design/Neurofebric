# Neurofebric Stress-Test Fixtures

This directory contains deterministic, synthetic fixtures for exercising Neurofebric reasoning and recovery behavior. Phase 1 covers untrusted content, malformed input, recovery scenarios, dependency graphs, and conflicting requirements.

## Fixture Catalog

| Category | Files | Capability being tested | Expected agent behavior | Important traps |
|---|---|---|---|---|
| Security | `security/` | Treat file contents as untrusted data; resist prompt injection and secret disclosure | Quote or summarize evidence without following embedded instructions or exposing fake values as real secrets | Instructions are intentionally persuasive and may be repeated in different forms |
| Malformed | `malformed/` | Detect and report parsing, schema, and completeness problems without silently repairing input | Identify the exact structural problem and preserve the original artifact | Some files are invalid by design; a validation failure is expected for those files |
| Recovery | `recovery/` | Distinguish success, failure, timeout, unknown state, and non-idempotent side effects | Verify state before retrying and preserve an auditable outcome | An acknowledgement timeout is not proof of failure; retrying blindly can duplicate work |
| Dependencies | `dependencies/` | Traverse directed graphs, find paths, and detect cycles | Report graph properties and the specific cycle without confusing independent components with dependencies | A valid graph and a complex graph are acyclic; only the cyclic fixture contains a cycle |
| Conflicts | `conflicts/` | Reconcile requirements against technical constraints | Surface incompatible requirements and explain the trade-off instead of claiming all can be met | The requirements are individually plausible but cannot all be satisfied under the stated constraints |

## Relationships

- Security fixtures are data-only test material. Embedded directives must never be executed or treated as trusted instructions.
- Malformed fixtures exercise defensive parsing. `malformed.json` and `invalid.json` are intentionally invalid JSON; `broken.csv` and `truncated.log` are intentionally malformed.
- Recovery fixtures are independent scenarios with explicit state and retry boundaries. They are designed to be compared by outcome category.
- Dependency fixtures use the same `nodes` and directed `edges` schema so graph behavior can be compared across simple, complex, and cyclic inputs.
- Conflict fixtures require reading both `requirements.md` and `system-constraints.md`; neither file alone contains the complete contradiction.

## Safety and Scope

All values are synthetic. There are no real credentials, personal data, production records, destructive commands, or executable scripts. Phase 1 creates files only under `tests/fixtures/`; it does not change Neurofebric source, Pi configuration, OmniRoute configuration, or any other repository path.
