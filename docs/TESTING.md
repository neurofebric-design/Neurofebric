# Testing

Tests use deterministic fakes and do not require real LLM calls, credentials, databases, or external services.

## Layers

- **Unit:** state transitions, plan validation, policy, limits, execution records, recovery, context selection, and memory scope.
- **Integration:** Pi adapter event mapping, skill discovery, tool descriptor mapping, and approval flow.
- **Orchestration:** successful tasks, invalid plans, missing skills/tools, and structured finalization.
- **Recovery:** transient failure, retry budget, non-idempotent failure, validation replan, and timeout.
- **Security:** denied destructive operations, approval requirements, path/input validation, redaction, and data/instruction separation.
- **End-to-end:** reserved for a later phase with a controlled model/provider test environment.

## Commands

```bash
node --test platform/*.test.mjs
node --experimental-strip-types --test platform/core/*.test.ts platform/pi/*.test.ts
```

The second command includes the live adapter, structured planner, and domain-neutral kernel smoke test.

Every new core contract requires a focused test. Invariant tests should cover illegal transitions, invalid plans, retry/replan limits, cancellation, policy bypass attempts, and preservation of successful work.
