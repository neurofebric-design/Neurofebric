# F-002 — Dual Policy Enforcement Implementations

## Problem
Two divergent policy/limits implementations exist and enforce write
budgets independently:
- core/policy_engine.py (Python, legacy harness: main.py, agents/)
- platform/core/ (TypeScript kernel, loaded via .pi/extensions/platform-orchestrator.ts)
Fixes must target the system the gauntlet actually exercised (see F-000
STEP 0 evidence).

## Status
LOGGED, NOT IMPLEMENTED. Resolution (deprecate / unify / maintain both)
is a product decision, out of scope for the F-000 fix session.
