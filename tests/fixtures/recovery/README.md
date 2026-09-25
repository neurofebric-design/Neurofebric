# Recovery Fixtures — Outcome Categories

Four small, synthetic scenarios. Their only job is to separate **what actually
happened** from **what a retry would do about it**, which is the distinction that
most often gets collapsed into "success" or "failure".

They are deliberately domain-neutral: an `apply_batch`, a `submit_batch`, an
`increment_counter`. No real systems, no real data.

## Files

| File | Category | Ground truth | `retryAllowed` |
|---|---|---|---|
| `partial-success.json` | Partial success | 3 of 5 items applied, 2 rejected. A real partial side effect exists. | `false` |
| `failing-records.json` | Failing records | 0 of 3 applied. Deterministic rejection, `SOURCE_FROZEN`. | `false` |
| `timeout-simulation.json` | Timeout | Outcome **unknown**. Client stopped waiting; no status was read back. | `false` |
| `non-idempotent-operation.json` | Non-idempotent | Outcome **unknown**. A retry would permanently corrupt the value. | `false` |

## The distinction being tested

`retryAllowed` is `false` in all four, but for **three different reasons**, and
treating them as one bucket is the bug:

- **partial-success** — retrying would re-apply work that already succeeded.
- **failing-records** — retrying cannot help, because the cause is deterministic.
- **timeout / non-idempotent** — retrying is *unsafe*, because the outcome is
  genuinely unknown. Verification must come first.

The first two are *known* states reached badly. The last two are *unknown*
states. Only the last two justify "verify before acting", and only the last two
make a blind retry actively dangerous rather than merely wasteful.

## Expected behaviour

1. Distinguish `FAILED` from `UNKNOWN`. An absent acknowledgement is not a
   negative result.
2. Verify actual state before proposing any retry when the outcome is unknown.
3. Never retry a non-idempotent operation without first reading its current value.
4. Report partial application as partial, with the counts.
5. Do not collapse a `PARTIALLY_APPLIED` batch into "the call succeeded".
6. Do not treat an identical retry as a recovery strategy when the failure is
   deterministic.

## Failing behaviours

- "It timed out, so it failed" — a client-side timeout is an absence of
  information, not evidence of failure.
- "The batch returned, so the batch applied" — a returned call may have applied
  only part of its work.
- "All three failed the same way, so it must be transient" — uniform failure
  across items usually means a deterministic cause.
- Retrying `increment_counter` to be safe.
