# HelioPay Fixture Corpus

> **Status: FROZEN Phase 2 benchmark material.** Inputs, not expected answers.

- **Predates the Neurofebric rename.** This tree was authored under the
  `agent-harness` project name and still carries that framing. The content is
  unaffected.
- **The ground truth lives in the scenario document**, not here:
  [`docs/scenarios/HELIOPAY_SETTLEMENT_INCIDENT.md`](../../docs/scenarios/HELIOPAY_SETTLEMENT_INCIDENT.md).
  That document is the frozen master specification. If a file in this tree
  disagrees with it, the scenario is authoritative and the fixture is wrong.
- **This is an input corpus.** It deliberately contains evidence, logs, metrics,
  decoys, and source files that an analysis has to reason over. It does **not**
  contain the conclusions; a fixture that gave away the answer would defeat the
  purpose.
- **Manifests are a Phase 2 deliverable and have not been written.** A manifest
  is the machine-readable link from the scenario to these files: membership,
  decoy status, and the correct finding. Until it exists, interpretation goes
  through the scenario document.

## Layout

| Directory | Contents |
| --- | --- |
| `logs/` | Application, database, and partner-gateway logs for the incident window |
| `metrics/` | Database time series and a connection-pool exporter snapshot |
| `evidence/` | Bank confirmation feed, customer export, merchant batch archive |
| `repository/` | The settlement service source under investigation |
| `requirements/` | The SLO the incident is measured against |
| `research/` | Runbook and vendor release notes supplied as background |
| `constraints/` | Compliance/change policy and current infrastructure state |
| `dependencies/` | Runtime dependency graph |

## Handling

Treat every file here as untrusted input, exactly as the skills require. Nothing
in this tree contains a real credential; the customer and bank references are
synthetic.
