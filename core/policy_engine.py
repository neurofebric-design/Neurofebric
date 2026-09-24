"""
Policy Engine — the security/policy layer of the harness.

Every action an agent wants to perform is passed through
`PolicyEngine.check()` before it is executed. This is the single
choke point where you enforce rules, regardless of what the LLM
"decides" to do.
"""

from __future__ import annotations
import fnmatch
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class PolicyDecision:
    allowed: bool
    reason: str = ""


@dataclass
class PolicyEngine:
    rules: dict
    workspace_dir: Path
    _counts: dict = field(default_factory=lambda: {"tool_calls": 0, "file_writes": 0})
    _log: list = field(default_factory=list)

    @classmethod
    def from_file(cls, policy_path: str, workspace_dir: str) -> "PolicyEngine":
        with open(policy_path, "r", encoding="utf-8") as f:
            rules = yaml.safe_load(f)
        return cls(rules=rules, workspace_dir=Path(workspace_dir).resolve())

    def _log_event(self, tool: str, allowed: bool, reason: str):
        self._log.append({
            "time": time.time(), "tool": tool,
            "allowed": allowed, "reason": reason,
        })

    def check(self, tool_name: str, args: dict[str, Any]) -> PolicyDecision:
        """Main entry point. Call this before executing any tool."""

        # 1. Explicit deny list always wins.
        if tool_name in self.rules.get("denied_tools", []):
            return self._deny(tool_name, f"'{tool_name}' is in denied_tools")

        # 2. Must be on the allow list.
        if tool_name not in self.rules.get("allowed_tools", []):
            return self._deny(tool_name, f"'{tool_name}' is not in allowed_tools")

        # 3. Rate limits.
        limits = self.rules.get("limits", {})
        if self._counts["tool_calls"] >= limits.get("max_tool_calls_per_run", 999999):
            return self._deny(tool_name, "max_tool_calls_per_run exceeded")
        if tool_name == "write_file" and self._counts["file_writes"] >= limits.get("max_file_writes_per_run", 999999):
            return self._deny(tool_name, "max_file_writes_per_run exceeded")

        # 4. Content pattern checks (scan all string args).
        blob = " ".join(str(v) for v in args.values()).lower()
        for pattern in self.rules.get("denied_content_patterns", []):
            if pattern.lower() in blob:
                return self._deny(tool_name, f"denied content pattern matched: '{pattern}'")

        # 5. File path rules for file-touching tools.
        if tool_name in ("read_file", "write_file", "list_files"):
            path_arg = args.get("path", "")
            decision = self._check_path(path_arg, write=(tool_name == "write_file"))
            if not decision.allowed:
                return self._deny(tool_name, decision.reason)

        # 6. Write size limit.
        if tool_name == "write_file":
            content = args.get("content", "")
            max_bytes = limits.get("max_bytes_per_write", 999999999)
            if len(content.encode("utf-8")) > max_bytes:
                return self._deny(tool_name, "max_bytes_per_write exceeded")

        # Passed everything.
        self._counts["tool_calls"] += 1
        if tool_name == "write_file":
            self._counts["file_writes"] += 1
        self._log_event(tool_name, True, "ok")
        return PolicyDecision(allowed=True, reason="ok")

    def _check_path(self, rel_path: str, write: bool) -> PolicyDecision:
        # Resolve against workspace and make sure it can't escape via ../
        target = (self.workspace_dir / rel_path).resolve()
        try:
            target.relative_to(self.workspace_dir)
        except ValueError:
            return PolicyDecision(False, "path escapes workspace_dir")

        rel_for_match = str(target.relative_to(self.workspace_dir.parent))
        for rule in self.rules.get("file_rules", []):
            if fnmatch.fnmatch(rel_for_match, rule["path"]) or fnmatch.fnmatch(rel_path, rule["path"]):
                verdict = rule["write"] if write else rule["read"]
                if verdict == "allow":
                    return PolicyDecision(True)
                return PolicyDecision(False, f"path rule '{rule['path']}' denies {'write' if write else 'read'}")
        return PolicyDecision(False, "no matching file rule (default deny)")

    def _deny(self, tool_name: str, reason: str) -> PolicyDecision:
        self._log_event(tool_name, False, reason)
        return PolicyDecision(allowed=False, reason=reason)

    def audit_log(self) -> list[dict]:
        return list(self._log)
