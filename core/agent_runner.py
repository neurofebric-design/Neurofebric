"""
Agent Runner — the core loop.

    1. Send the agent's system prompt + conversation to the LLM.
    2. Parse the LLM's reply for a tool call (strict JSON format).
    3. Pass that tool call through the PolicyEngine.
    4. If allowed, execute it and feed the result back to the LLM.
    5. If denied, tell the LLM why, so it can try a different approach.
    6. Repeat until the agent emits a "final_answer" action or the
       step limit is hit.

The LLM is instructed to ALWAYS reply with a single JSON object:
    {"action": "<tool_name>", "args": {...}}
    or
    {"action": "final_answer", "content": "..."}
"""

from __future__ import annotations
import json
from pathlib import Path

from rich.console import Console

from core.llm_client import LLMClient
from core.policy_engine import PolicyEngine
from tools import file_tools

console = Console()

TOOL_IMPL = {
    "read_file": lambda ws, args: file_tools.read_file(ws, **args),
    "write_file": lambda ws, args: file_tools.write_file(ws, **args),
    "list_files": lambda ws, args: file_tools.list_files(ws, **args),
    "web_search_stub": lambda ws, args: file_tools.web_search_stub(**args),
}


class AgentRunner:
    def __init__(self, settings: dict, system_prompt: str):
        self.settings = settings
        self.workspace_dir = settings["workspace_dir"]
        Path(self.workspace_dir).mkdir(parents=True, exist_ok=True)

        self.llm = LLMClient(settings)
        self.policy = PolicyEngine.from_file(settings["policy_file"], self.workspace_dir)
        self.system_prompt = system_prompt + "\n\n" + self._format_instructions()
        self.messages: list[dict] = []

    def _format_instructions(self) -> str:
        return (
            "You must respond with ONLY a single JSON object, no prose outside it.\n"
            'To use a tool: {"action": "<tool_name>", "args": {...}}\n'
            'To finish: {"action": "final_answer", "content": "..."}\n'
            f"Available tools: {list(TOOL_IMPL.keys())}"
        )

    def run(self, task: str) -> str:
        self.messages.append({"role": "user", "content": task})
        max_steps = self.settings.get("max_steps_per_run", 25)

        for step in range(max_steps):
            reply = self.llm.complete(self.system_prompt, self.messages)
            self.messages.append({"role": "assistant", "content": reply})

            try:
                parsed = json.loads(reply)
            except json.JSONDecodeError:
                console.print(f"[yellow]step {step}: model did not return valid JSON, nudging it[/yellow]")
                self.messages.append({"role": "user", "content": "That was not valid JSON. Reply with ONLY the JSON object."})
                continue

            action = parsed.get("action")

            if action == "final_answer":
                console.print(f"[green]done after {step + 1} step(s)[/green]")
                return parsed.get("content", "")

            args = parsed.get("args", {})
            decision = self.policy.check(action, args)

            if not decision.allowed:
                console.print(f"[red]step {step}: blocked '{action}' — {decision.reason}[/red]")
                self.messages.append({
                    "role": "user",
                    "content": f"Action denied by policy: {decision.reason}. Try a different approach."
                })
                continue

            try:
                result = TOOL_IMPL[action](self.workspace_dir, args)
                console.print(f"[cyan]step {step}: ran '{action}'[/cyan]")
            except Exception as e:
                result = f"ERROR running {action}: {e}"
                console.print(f"[red]step {step}: {result}[/red]")

            self.messages.append({"role": "user", "content": f"Tool result: {result}"})

        return "Stopped: max_steps_per_run reached without a final_answer."

    def audit_log(self):
        return self.policy.audit_log()
