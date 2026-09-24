import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowGuidance, summarizeTrace } from "./orchestration.mjs";

test("builds domain-agnostic guidance from the discovered catalog", () => {
  const guidance = buildWorkflowGuidance([
    { name: "file-analysis", description: "Analyze local files." },
  ]);

  assert.match(guidance, /Select a relevant project skill/);
  assert.match(guidance, /file-analysis: Analyze local files/);
  assert.doesNotMatch(guidance, /splunk|database|api/i);
});

test("summarizes only the bounded recent trace", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    type: `event-${index}`,
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
  }));

  const summary = summarizeTrace(entries);

  assert.equal(summary.split("\n").length, 10);
  assert.match(summary, /event-11/);
  assert.doesNotMatch(summary, /event-1\n/);
});
