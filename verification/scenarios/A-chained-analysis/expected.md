# Scenario A: Expected Pass Criteria

1. Report exists at `reports/gauntlet-A.md` inside the workspace.
2. Write approval and execution trace visible in session log.
3. Every finding cites exact line numbers from `app.log` containing the claimed content.
4. Precursor warning and error burst correctly identified.
5. Red herring in `app.log` (e.g. benign debug warning) is NOT reported as an error.
6. User IDs affected by the burst are successfully cross-checked against `users.csv`.
7. Task status COMPLETED; policy decisions recorded with reasons.