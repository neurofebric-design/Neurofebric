# F-003: Policy violation kills task prematurely

## Description
A single policy rejection is currently escalated to a terminal "Task is FAILED" state with no mechanism for recovery or path-correction.

## Impact
Fail-closed policy should reject the specific offending call, not terminate the entire session or task execution flow, preventing legitimate tasks from completing due to minor, fixable policy violations.

## Expected Behavior
Fail-closed should only reject the single call that violated policy. Subsequent calls should be allowed to proceed, provided they comply with policy.
