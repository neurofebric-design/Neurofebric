"""
Entry point. Run with:

    python main.py analyze <filename-in-workspace>

Put the file you want analyzed into the workspace/ folder first.
"""

import sys
import yaml

from agents.deep_research_agent import run_deep_research


def load_settings(path="config/settings.yaml") -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "analyze":
        print("Usage: python main.py analyze <filename-in-workspace>")
        sys.exit(1)

    filename = sys.argv[2]
    settings = load_settings()
    result = run_deep_research(settings, filename)
    print("\n=== FINAL RESULT ===")
    print(result)


if __name__ == "__main__":
    main()
