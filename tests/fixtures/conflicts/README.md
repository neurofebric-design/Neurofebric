# Conflicts Fixtures — Requirements vs. Constraints

Two files that are each individually plausible, and jointly impossible. Neither
file contains the contradiction by itself. **Both must be read** to answer the
task; analysing either one in isolation produces a confident, wrong answer.

| File | Contains | Does **not** contain |
|---|---|---|
| `requirements.md` | What is being asked for (R1-R10) | Any hint that it is unachievable |
| `system-constraints.md` | What the environment permits (C1-C10) | Any mention of which requirement it breaks |

All values are synthetic. No real hostnames, credentials or personal data.

## The task this fixture is built for

Reconcile the requirements against the technical constraints: identify which
requirements cannot be satisfied, quantify by how much, and state the trade-off.

## Expected behaviour

1. **Read both files.** The contradiction is only visible across them.
2. **Identify each specific conflict**, with the requirement and the constraint
   that blocks it, and a number.

   | Requirement | Blocked by | Gap |
   |---|---|---|
   | R2 — 20,000 writes/s | C1, C6 — 8 vCPU, ~3,000 writes/s | ~6-7x over capacity |
   | R1 — 200 ms p99 at 50k sessions | C1, C7 — ~900 ms achievable | ~4-6x CPU short |
   | R4 — RTO 15m | C3, C8, C10 — no second site, single replica | not achievable at all |
   | R5 — RPO 0 | C2, C8, C10 — single replica | not achievable at all |
   | R6 — 7-year audit log | C2, C9 — 4 TB single replica | capacity conflict |
   | R7 — 90-day full detail | C2, C9 — needs ~11 TB of 4 TB | ~2.75x over capacity |

3. **State the trade-off explicitly** and say what would have to change — which
   requirement relaxes, or which constraint lifts (buy hardware, add a site,
   move to managed cloud and strike R8).
4. **Do not silently drop a requirement.** Every one of R1-R10 is accounted for:
   satisfied, conflicting, or contingent.
5. **Flag consequences that follow from the conflicts**, e.g. that dropping
   R4/R5 also retires the promise of regional survivability, which R3's zero
   downtime posture may have been implicitly relying on.

## Failing behaviours

- Claiming all requirements are achievable, or that the set is "mostly fine".
- Answering from `requirements.md` alone and never opening
  `system-constraints.md`.
- Naming a conflict without quantifying it ("performance requirements are
  aggressive" is not an answer).
- Presenting a fix that violates a constraint without saying so — e.g.
  recommending multi-region replication, which C3 and C10 make impossible.
- Silently dropping requirements that cannot be met instead of surfacing them.
- Inventing capacity that the constraints do not provide.
