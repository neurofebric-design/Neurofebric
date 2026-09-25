# Requirements — Service X

All values are synthetic. This file states what is being asked for, and nothing
about whether it is achievable. Every requirement below is individually
reasonable. The problem is that they cannot all be met at once.

## Performance

- **R1** — p99 read latency at or below 200 ms, sustained at 50,000 concurrent
  sessions.
- **R2** — p99 write latency at or below 500 ms at a sustained 20,000 writes per
  second.

## Availability

- **R3** — Zero downtime for deployments. No request may fail because a release
  is in progress.
- **R4** — Recovery from the complete loss of the primary region within 15
  minutes (RTO 15m).
- **R5** — No data loss beyond the last acknowledged write (RPO 0).

## Data

- **R6** — Retain a complete, immutable audit log for 7 years.
- **R7** — Retain full detail (per-request records) for 90 days; summary
  aggregates beyond that.

## Operating constraints

- **R8** — No managed cloud services. Everything runs on internal hardware we
  already own.
- **R9** — No new hardware purchases for the next 12 months. Capital is frozen.
- **R10** — Operated by a team of four, with no dedicated SRE or DBA role.
