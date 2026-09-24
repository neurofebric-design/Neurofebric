"""
Sandboxed file tools. These are the actual implementations that run
ONLY after the policy engine has approved the action — this file
does no permission-checking itself, it trusts the caller to have
already gone through PolicyEngine.check().
"""

from pathlib import Path


def read_file(workspace_dir: str, path: str) -> str:
    target = Path(workspace_dir) / path
    return target.read_text(encoding="utf-8")


def write_file(workspace_dir: str, path: str, content: str) -> str:
    target = Path(workspace_dir) / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"wrote {len(content)} chars to {path}"


def list_files(workspace_dir: str, path: str = ".") -> str:
    target = Path(workspace_dir) / path
    entries = sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir())
    return "\n".join(entries)


def web_search_stub(query: str) -> str:
    # Placeholder — wire up a real search API here later if you want.
    # Left as a stub so the harness runs with zero paid dependencies
    # out of the box.
    return f"[web_search_stub] no live search configured yet for: {query!r}"
