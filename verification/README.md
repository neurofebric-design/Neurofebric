# Verification Gauntlet

This directory contains the end-to-end verification gauntlet for Neurofebric, testing the platform kernel, policy engine, skill discovery, redaction boundary, and LLM orchestration across 8 rigorous scenarios (A–H).

## Re-running the Gauntlet

Each scenario runs in its own fresh pinned child session:
```bash
pi --provider omni --model auto/gemini -- -p "<task prompt>"
```

See `verification/scenarios/*/` for fixtures, task definitions, and expected pass criteria.
See `reports/REPORT.md` for full gauntlet results, metrics, and pre-flight findings.
