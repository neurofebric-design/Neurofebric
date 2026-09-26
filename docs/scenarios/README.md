# Scenario Specifications — Frozen Phase 2 Benchmark Material

> **Status: FROZEN.** These are not living documentation and should not be
> edited casually.

- **These documents predate the Neurofebric rename.** They were authored when
  this repository was still the `agent-harness` Python-era project and still
  carry that naming. The scenarios themselves are unaffected; only the framing
  is historical.
- **The ground truth for each incident lives in the scenario documents here, not
  in the fixture tree.** A scenario document is the master specification: it is
  frozen first, and any fixture or manifest must be derived from it rather than
  invented independently. If a fixture and a scenario disagree, the scenario is
  authoritative and the fixture is wrong.
- **`tests/fixtures/helioPay/` are inputs, not expected answers.** They are a
  hand-built evidence corpus (logs, metrics, evidence files, repository source,
  research notes) for exercising the analysis skills. They do **not** contain the
  conclusions.
- **Manifests are a Phase 2 deliverable and have not been written yet.** A
  manifest is the machine-readable link from a scenario to its fixtures: which
  files belong to the scenario, which are decoys, and what the correct finding
  is. Until it exists, a fixture file can only be interpreted by reading the
  scenario document, which is the intended workflow for now.

## Contents

| File | What it is |
| --- | --- |
| `AEGIS_FLEET_COLDCHAIN_INCIDENT.md` | Master scenario: cold-chain fleet telemetry incident |
| `HELIOPAY_SETTLEMENT_INCIDENT.md` | Master scenario: the "47-minute ledger stall" settlement control-plane incident |

## Before extending

If you need to change a scenario, do not edit it in place. Write a new
specification, freeze that, and regenerate its fixtures from it. The value of this
material is that it was written once and then held still, so that any analysis
run against it can be trusted to have reasoned from a fixed premise.
