# Manual Test Procedures — Legacy

> **Status: LEGACY manual procedures.** Kept for reference; not part of the
> automated gate.

- **This predates the Neurofebric rename** and describes the project as it was
  when these procedures were written.
- **The automated suites are the gate.** Everything here that can be expressed as
  a `node --test` case now is: the trust-model and boundary checks live in
  `platform/pi/trusted-execution.test.ts`, artifact and completion checks in
  `platform/pi/artifact-flow.test.ts`, redaction in
  `platform/pi/redaction-boundary.test.ts`, and the declarative policy in
  `platform/pi/policy-port.test.ts` and `platform/core/policy-config.test.ts`.
  Run those three suites instead of working through this file.
- **What remains here is what genuinely needs a human or a live model**: running
  a real Pi session, judging answer quality, and checking the `/platform` output.
  Those are not automatable, which is why this file is still useful.
- **The run-log table at the bottom is append-only.** It is a record of past
  manual runs. Do not clear it; add new rows.

If you convert a case here into an automated test, remove it from this file in
the same change and note the replacement test in the commit message, so the two
do not drift apart.
