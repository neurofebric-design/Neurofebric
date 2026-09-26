# Criteria for File Limits Fix

1.  **Scope**: `policies/` is now an allowed directory for this fix.
2.  **Implementation - Bookkeeping**: `_bookkeeping_paths/max*` will be passed via constructor as instance attributes, not `setattr` on the class.
3.  **Implementation - Path Normalization**: Normalize all paths (both user-provided and internal patterns) to POSIX format (forward slashes) before `fnmatch`.
4.  **Implementation - Budget Exhaustion**:
    *   If Scenario E asserts the legacy halt string "max_file_writes_per_run exceeded", this string must be preserved.
    *   The termination record MUST include a structured field to distinguish the ledger (`ledger: "task" | "bookkeeping"`).
5.  **Implementation - Legacy Cleanup**:
    *   Search for "file_writes".
    *   Update or justify every remaining reference.
