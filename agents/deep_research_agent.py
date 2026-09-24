"""
Example agent: reads a document from the workspace, analyzes it,
and writes a report — the "long-running deep research" idea.

This is intentionally simple. It shows the pattern; extend it with
multi-pass analysis, chunking for long docs, citations, etc.
"""

from core.agent_runner import AgentRunner

SYSTEM_PROMPT = """\
You are a careful research analyst agent. Given a document in the
workspace, you should:
1. list_files to see what's available if you don't know the filename.
2. read_file to read the document.
3. Think about its structure, key claims, and any gaps or risks.
4. write_file to save a report to "report.md" summarizing:
   - Executive summary
   - Key findings
   - Open questions / risks
   - Recommended next steps
5. Then finish with final_answer summarizing what you wrote.
Be thorough but do not pad with filler.
"""


def run_deep_research(settings: dict, document_filename: str) -> str:
    runner = AgentRunner(settings, SYSTEM_PROMPT)
    task = (
        f"Analyze the document at '{document_filename}' in the workspace "
        f"and produce report.md as instructed."
    )
    result = runner.run(task)
    for entry in runner.audit_log():
        if not entry["allowed"]:
            print(f"[policy] blocked {entry['tool']}: {entry['reason']}")
    return result
