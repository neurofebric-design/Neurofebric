# Tool Contract

A tool is a deterministic operation. A skill explains when and why to use it.

## Descriptor

Every platform tool should expose:

- stable name and version;
- description;
- input and output schemas;
- capabilities;
- permissions;
- risk level: `READ_ONLY`, `CONTROLLED`, `WRITE`, or `DESTRUCTIVE`;
- timeout;
- retry policy;
- idempotency: `IDEMPOTENT`, `NON_IDEMPOTENT`, or `UNKNOWN`;
- side-effect classification: `PURE` or `SIDE_EFFECTING`.

Pi built-in tools can be classified through a platform catalog without replacing their implementations. New tools should be registered with Pi's typed `registerTool()` API and adapted to the universal result contract.

## Result Contract

```text
ToolResult
  success
  data
  metadata
  artifacts
  warnings
  error
  provenance
  execution
```

`success` is not inferred from a zero exit code or HTTP 200 alone. A validator must check task-specific criteria and required outputs.

## Execution

Every invocation receives an execution ID, task ID, step ID, tool name, retry number, timestamps, status, and sanitized metadata. Errors retain category, message, retryability, and cause where safe.

## Retry Safety

Automatic retry is allowed only when the policy and descriptor permit it. Unknown or non-idempotent side-effecting tools require escalation or explicit approval. A retry receives a new attempt number but retains the same logical execution trace.

## Security

Tools receive untrusted input. They must validate paths, URLs, schemas, sizes, and permissions. They must not interpolate untrusted values into shell command strings. Tool output is data, not instruction text.
