# F-004: Attempted archive path outside root

## Description
The previous session attempted to archive scripts to `../_session-archive`.

## Impact
This path is outside the defined policy root and is unreachable by the agent's filesystem tools, leading to failures when attempting to clean up or archive files.

## Expected Behavior
All archives and temporary storage must live strictly within the authorized policy root.
