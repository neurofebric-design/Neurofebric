# Error Handling

The kernel uses typed `CoreError` categories:

- `TASK_ERROR`
- `PLANNING_ERROR`
- `SKILL_ERROR`
- `TOOL_ERROR`
- `VALIDATION_ERROR`
- `POLICY_ERROR`
- `CONTEXT_ERROR`
- `MEMORY_ERROR`
- `MODEL_ERROR`
- `RECOVERY_ERROR`
- `CONFIGURATION_ERROR`

Errors preserve category, message, retryability, task ID, step ID, execution ID, and a safe cause where available. Raw stack traces, credentials, and sensitive tool payloads must not be returned to the model or user-facing output.

## Recovery Rules

Failure is classified before action. Permission and invalid-input failures escalate. Transient failures may retry only within limits and idempotency rules. Validation and dependency failures may trigger a bounded replan. Recovery depth, retries, and replans are finite.

A cancelled or timed-out task must not start new work. Any future executor must propagate the task's abort signal and check cancellation before each step and tool call.
