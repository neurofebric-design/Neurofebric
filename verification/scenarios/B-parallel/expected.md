# Scenario B: Expected Pass Criteria

1. All 3 log files analyzed in a single run.
2. No state corruption across files.
3. Trace entries ordered.
4. Summary provided in combined severity order (CRITICAL -> ERROR -> WARN -> INFO).
5. Output reflects findings from all three logs (log1: Auth failure, log2: Disk space critical, log3: Memory leak warning).