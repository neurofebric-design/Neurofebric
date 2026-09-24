"""
LLM Client — thin abstraction so the rest of the harness doesn't
care whether it's talking to a free local Ollama model or the
Anthropic API. Swap backends by editing config/settings.yaml.
"""

from __future__ import annotations
import json
import os
import requests


class LLMClient:
    def __init__(self, settings: dict):
        self.backend = settings["llm_backend"]
        self.settings = settings

    def complete(self, system_prompt: str, messages: list[dict]) -> str:
        if self.backend == "ollama":
            return self._complete_ollama(system_prompt, messages)
        elif self.backend == "anthropic":
            return self._complete_anthropic(system_prompt, messages)
        elif self.backend == "omniroute":
            return self._complete_omniroute(system_prompt, messages)
        else:
            raise ValueError(f"Unknown llm_backend: {self.backend}")

    # -- Ollama (free, runs locally, no API key) ------------------
    def _complete_ollama(self, system_prompt: str, messages: list[dict]) -> str:
        cfg = self.settings["ollama"]
        url = f"{cfg['base_url']}/api/chat"
        payload = {
            "model": cfg["model"],
            "messages": [{"role": "system", "content": system_prompt}] + messages,
            "stream": False,
        }
        resp = requests.post(url, json=payload, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["message"]["content"]

    # -- Anthropic API (needs ANTHROPIC_API_KEY env var) -----------
    def _complete_anthropic(self, system_prompt: str, messages: list[dict]) -> str:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY not set. On Windows: "
                'setx ANTHROPIC_API_KEY "sk-ant-..." then restart your terminal.'
            )
        cfg = self.settings["anthropic"]
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": cfg["model"],
                "max_tokens": cfg["max_tokens"],
                "system": system_prompt,
                "messages": messages,
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        return "".join(b["text"] for b in data["content"] if b["type"] == "text")

    # -- OmniRoute (self-hosted gateway, OpenAI-compatible, free tiers) ---
    def _complete_omniroute(self, system_prompt: str, messages: list[dict]) -> str:
        cfg = self.settings["omniroute"]
        url = f"{cfg['base_url']}/v1/chat/completions"
        payload = {
            "model": cfg["model"],
            "messages": [{"role": "system", "content": system_prompt}] + messages,
        }
        headers = {"content-type": "application/json"}
        api_key = os.environ.get("OMNIROUTE_API_KEY")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        resp = requests.post(url, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
