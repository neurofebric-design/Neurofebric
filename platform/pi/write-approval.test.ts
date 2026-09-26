import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { PiApprovalProvider } from "./approval.ts";
import { buildPolicy } from "./project-config.ts";
import { discoverSkills, skillRiskLevel } from "../skill-registry.mjs";

/**
 * The write tier, proven end to end.
 *
 * A skill may *declare* `risk: write` (report-writer does), but that grants
 * nothing. This suite pins the actual enforcement path:
 *
 *   report-writer declares risk write
 *     -> the tool it needs (`write`) is classified WRITE by the tool adapter
 *       -> DefaultPolicy returns REQUIRE_APPROVAL
 *         -> the approval provider is consulted
 *           -> no UI means the provider refuses, and the call is DENIED
 *
 * It also pins the workspace half of the boundary: a write *inside* the
 * workspace is ordinary work, a write *outside* it is denied with a reason, in
 * both trust models.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const TOOL_NAMES = ["read", "bash", "write", "edit", "grep", "find", "ls"];

function approvalModeAdapter() {
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "APPROVAL", allowedRoots: ["."] }, PROJECT_ROOT));
  for (const name of TOOL_NAMES) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  return adapter;
}

function trustedModeAdapter(allowedRoots: string[]) {
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots }, PROJECT_ROOT));
  for (const name of TOOL_NAMES) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  return adapter;
}

test("A. report-writer is registered as a write-tier skill, and read-tier skills are not", async () => {
  const skills = await discoverSkills(path.join(PROJECT_ROOT, "skills"), { knownTools: TOOL_NAMES });
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  assert.equal(skillRiskLevel(byName.get("report-writer")!), "WRITE", "report-writer must declare risk write");
  for (const readTier of ["file-analysis", "log-analysis", "structured-data"]) {
    assert.equal(
      skillRiskLevel(byName.get(readTier)!),
      "READ_ONLY",
      `${readTier} must default to read`,
    );
  }

  // The label is consistent with the tool the skill actually needs.
  const writeTool = toolDescriptorFromPi({ name: "write", description: "write" });
  assert.equal(writeTool.riskLevel, "WRITE");
  assert.ok(byName.get("report-writer")!.requiredTools.includes("write"));
});

test("B. a write-tier tool call routes through the approval provider", async () => {
  const adapter = approvalModeAdapter();
  await adapter.beginTask("write the incident report", "write the incident report");

  const asked: string[] = [];
  const approval = new PiApprovalProvider(true, async (prompt) => {
    asked.push(prompt);
    return true;
  });

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "reports/incident.md", content: "# Findings" },
    approval,
    "w1",
  );

  assert.equal(decision.decision, "ALLOW", "an approved write is allowed");
  assert.equal(asked.length, 1, "the approval provider must actually be consulted");
  assert.match(asked[0], /write requires approval/);

  const events = adapter.recentEvents(200).map((event) => event.type);
  assert.ok(events.includes("APPROVAL_REQUIRED"), "the approval must be recorded in the trace");
});

test("C. a refused write is denied and never binds an execution", async () => {
  const adapter = approvalModeAdapter();
  await adapter.beginTask("write the incident report", "write the incident report");

  const refused = new PiApprovalProvider(true, async () => false);
  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "reports/incident.md", content: "# Findings" },
    refused,
    "w2",
  );

  assert.equal(decision.decision, "DENY");
  assert.match((decision as { reason: string }).reason, /Approval denied/);
  assert.equal(await adapter.beginToolExecution("w2", "write"), undefined);
  assert.equal(adapter.activeExecution("w2"), undefined);
  assert.ok(adapter.recentEvents(200).map((event) => event.type).includes("APPROVAL_DENIED"));
});

test("D. a non-interactive run (no UI) fails closed instead of hanging or auto-approving", async () => {
  const adapter = approvalModeAdapter();
  await adapter.beginTask("write the incident report", "write the incident report");

  // PiApprovalProvider with hasUI=false must never reach the dialog callback.
  let dialogShown = false;
  const headless = new PiApprovalProvider(false, async () => {
    dialogShown = true;
    return true;
  });

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "reports/incident.md", content: "# Findings" },
    headless,
    "w3",
  );

  assert.equal(decision.decision, "DENY", "a write with no UI must be denied, never assumed");
  assert.equal(dialogShown, false, "no dialog may be attempted without a UI");
  assert.equal(await adapter.beginToolExecution("w3", "write"), undefined);

  // Same for the other write-tier and controlled-tier tools.
  for (const [tool, input] of [
    ["edit", { path: "notes.md", old: "a", new: "b" }],
    ["bash", { command: "npm test" }],
  ] as [string, unknown][]) {
    const other = approvalModeAdapter();
    await other.beginTask("run a controlled operation", "run a controlled operation");
    const result = await other.precheckToolCall(tool, "execute", input, headless, `x-${tool}`);
    assert.equal(result.decision.decision, "DENY", `${tool} must fail closed without a UI`);
  }
});

test("E. a write inside the workspace is allowed; a write outside it is denied with a reason", async () => {
  // Trusted mode: a write inside the root is ordinary development work.
  const trusted = trustedModeAdapter([PROJECT_ROOT]);
  await trusted.beginTask("write a report", "write a report");

  const inside = await trusted.precheckToolCall(
    "write",
    "execute",
    { path: path.join(PROJECT_ROOT, "reports", "incident.md"), content: "# Findings" },
    undefined,
    "i1",
  );
  assert.equal(inside.decision.decision, "ALLOW");

  const escapes: [string, unknown][] = [
    ["absolute outside the root", { path: path.join(path.dirname(PROJECT_ROOT), "escape.md"), content: "x" }],
    ["parent traversal", { path: path.join(PROJECT_ROOT, "..", "escape.md"), content: "x" }],
    ["far traversal", { path: path.join(PROJECT_ROOT, "..", "..", "..", "Windows", "System32", "drivers", "etc", "hosts"), content: "x" }],
  ];

  for (const [label, input] of escapes) {
    const { decision } = await trusted.precheckToolCall("write", "execute", input, undefined, `o-${label}`);
    assert.equal(decision.decision, "DENY", `write ${label} must be denied`);
    assert.match(
      (decision as { reason: string }).reason,
      /path boundary violation/,
      `write ${label} must be denied with a boundary reason, got: ${(decision as { reason: string }).reason}`,
    );
  }

  // A boundary denial outranks approval: no provider may override it.
  const escalated = await trusted.precheckToolCall(
    "write",
    "execute",
    { path: path.join(PROJECT_ROOT, "..", "escape.md"), content: "x" },
    { requestApproval: async () => true },
    "o-approved",
  );
  assert.equal(escalated.decision.decision, "DENY", "an approving dialog must not escape the workspace");
});

test("F. a declared write-tier skill does not by itself permit an unapproved write", async () => {
  // Load the real catalog so the claim is about the real skills, then prove the
  // label has no enforcement power of its own.
  const skills = await discoverSkills(path.join(PROJECT_ROOT, "skills"), { knownTools: TOOL_NAMES });
  const reportWriter = skills.find((skill) => skill.name === "report-writer");
  assert.ok(reportWriter, "report-writer must exist in the catalog");
  assert.equal(skillRiskLevel(reportWriter), "WRITE");

  const adapter = approvalModeAdapter();
  adapter.setSkills(skills);
  await adapter.beginTask("write the incident report", "write the incident report");

  const headless = new PiApprovalProvider(false, async () => true);
  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "reports/incident.md", content: "# Findings" },
    headless,
    "w4",
  );

  assert.equal(
    decision.decision,
    "DENY",
    "a WRITE skill must still route its writes through the approval provider",
  );
});
