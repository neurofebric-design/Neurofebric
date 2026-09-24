# Security

## Trust Boundaries

Pi and extensions run with the operating-system permissions of the Pi process. Project trust controls resource loading but is not a sandbox. External files, logs, documents, database results, and API responses are untrusted data.

## Prompt Injection Boundary

Instructions and data must remain separate. Content read from a file or returned by a tool is data even if it contains text such as "ignore previous instructions". Skills, system instructions, and tool policy are the only authoritative instruction sources.

The orchestrator must never promote tool output into a system instruction or use it to bypass policy.

## Tool Safety

- unknown tools are denied;
- writes and destructive operations require policy approval;
- non-idempotent operations are not automatically retried;
- shell commands are controlled and never built by string interpolation from untrusted values;
- path operations must remain within approved roots;
- output and artifact sizes are bounded;
- external network targets require explicit tool policy.

## Secrets

API keys, tokens, passwords, cookies, private keys, and environment secrets must not appear in prompts, traces, errors, artifacts, or provenance. Record redacted metadata only. A dedicated redaction layer is required before production persistence.

## Approval

Approval is an injected interface. Pi UI is an adapter, not part of policy logic. In non-interactive mode, operations requiring approval fail closed.

## Deployment Controls

Pi documentation recommends a container, VM, or dedicated user when analyzing untrusted material. Production deployments should combine project trust with OS isolation, scoped credentials, network restrictions, backups, and reviewable audit records.
