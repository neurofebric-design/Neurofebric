# Finding F-005: Policy file sits inside the agent's allowed roots

- **ID:** F-005
- **Status:** Open (recorded; intentionally out of P1 scope)
- **Component:** Policy loading (`platform/core/policy-config.ts`) and workspace boundary config

## Description

`.pi/neurofebric-policy.json` lives inside `allowedRoots: ["."]`, so the agent's write-tier tools can technically reach the file that defines its own limits.

## Impact

D-004's rule that "the agent never edits its own policy configuration" is currently a convention, not an enforcement boundary. A misbehaving or injected agent could raise its own budgets.

## Expected Behavior

The policy file should be outside the agent-writable boundary, or its writes should be denied by a dedicated rule, so the operator-only guarantee is enforced by the kernel rather than by trust.
