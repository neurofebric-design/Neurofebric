# System Constraints — Service X

All values are synthetic. This file states what the environment physically
allows. Read together with `requirements.md`, it is what makes several of those
requirements impossible. Neither file contains the contradiction on its own.

## Hardware actually available

- **C1** — One on-prem cluster. **8 vCPU, 32 GB RAM**, single node.
- **C2** — Storage: **4 TB** total, **single replica only**. No second copy
  exists and no second copy can be created without new hardware.
- **C3** — No second site. There is no facility available to us in any region.

## Budget and staffing

- **C4** — Hardware budget frozen for 12 months (matches R9).
- **C5** — Team of four, no dedicated SRE or DBA (matches R10).

## Hard technical limits

- **C6** — With 8 vCPU and 32 GB RAM, the achievable sustained write throughput
  for this workload is approximately **3,000 writes/second**, measured on the
  same hardware with the same schema. 20,000 writes/second is roughly 6-7x the
  capacity of the entire machine, for all workloads combined.
- **C7** — At 50,000 concurrent sessions, 8 vCPU supports a p99 read latency of
  approximately **900 ms**, not 200 ms. Reaching 200 ms at that concurrency
  requires roughly 6x the CPU.
- **C8** — With a single replica, the loss of the primary region is total data
  loss. Recovery time is bounded by rebuild-from-backup, not by failover, and
  there is no other site to fail over to.
- **C9** — Per-request detail for 90 days at this request volume is approximately
  **11 TB**, which exceeds the 4 TB in C2 by a wide margin. Even 7 years of
  summary aggregates do not fit alongside it.
- **C10** — Cross-region replication requires a second site (C3) and replication
  hardware (C2, C4). All three are unavailable.

## What follows from the constraints alone

- R2 (20k writes/s) exceeds total machine capacity by ~6-7x (C1, C6).
- R1 (200 ms at 50k sessions) needs ~6x the available CPU (C1, C7).
- R4 (RTO 15m) and R5 (RPO 0) require a second site and a second copy of the
  data. Neither exists and neither can be bought this year (C2, C3, C8, C10).
- R6 and R7 require ~11 TB of retention against 4 TB of single-replica storage
  (C2, C9).
- R3 (zero-downtime deploys) is achievable on a single node only with
  in-place rolling techniques that are themselves constrained by C1.

These are stated here as observations about the environment. Reconciling them
against `requirements.md` — and deciding which requirement yields — is the task.
