import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { PiApprovalProvider } from "./approval.ts";
import { buildPolicy } from "./project-config.ts";
import { discoverSkills, skillRiskLevel } from "../skill-registry.mjs";
import { toSkillDescriptor, skillsForCapabilities } from "../core/skill-catalog.ts";

/**
 * The invariant that `risk` was allowed to enter the frontmatter without
 * breaking: **skill metadata is descriptive, never permissive.**
 *
 * `docs/SKILL_SPEC.md` says a skill may declare what it needs and what it
 * supports, and that it never grants a permission. Before `risk` existed, that
 * was enforced by rejecting the key outright. `risk` is now accepted, so this
 * suite has to prove the same property by behaviour rather than by rejection:
 *
 *   - a skill declaring riskLevel READ_ONLY cannot make a WRITE tool call succeed;
 *   - a skill declaring riskLevel WRITE cannot make one succeed either, in
 *     approval mode, with no UI, or through a boundary-escaping path;
 *   - there is no code path from a SkillDescriptor to a PolicyDecision.
 *
 * If a future change ever wires skill metadata into policy, these fail.
 *
 * RESIDUAL GAP (recorded deliberately, not fixed here). `precheckToolCall`
 * refuses to bind an execution for a DENY, but a `REQUIRE_APPROVAL` that was
 * never resolved still binds. The production path is safe because the
 * extension's `tool_call` hook returns `{ block: true }` for any non-ALLOW
 * decision, so Pi never emits `tool_execution_start`. Making the kernel itself
 * refuse to bind would be strictly safer, but it changes behaviour that seven
 * existing artifact-flow and redaction tests depend on, so it is a decision
 * for the owner rather than a change smuggled in beside a test.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const TOOL_NAMES = ["read", "bash", "write", "edit", "grep", "find", "ls"];

const READ_SKILL = toSkillDescriptor({
  name: "innocent-observer",
  description: "Reads things and reports on them.",
  requiredTools: ["read"],
  riskLevel: "READ_ONLY",
});

const WRITE_SKILL = toSkillDescriptor({
  name: "eager-writer",
  description: "Claims to write reports.",
  requiredTools: ["write"],
  riskLevel: "WRITE",
});

async function adapterWith(skills: ReturnType<typeof toSkillDescriptor>[], mode: "TRUSTED_PROJECT" | "APPROVAL" = "APPROVAL") {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-skill-authority-"));
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: mode, allowedRoots: ["."] }, root));
  for (const name of TOOL_NAMES) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  adapter.setSkills(skills);
  await adapter.beginTask("try to do something", "try to do something");
  return { adapter, root };
}

test("A. a READ_ONLY skill cannot make a write-tier tool call succeed", async () => {
  const withRead = await adapterWith([READ_SKILL]);
  const withNothing = await adapterWith([]);

  const call = (adapter: KernelAdapter, root: string, id: string) =>
    adapter.precheckToolCall(
      "write",
      "execute",
      { path: path.join(root, "report.md"), content: "# Report" },
      // No approval provider: exactly what a non-interactive or unconfigured run
      // passes. If a READ_ONLY skill could authorize anything, this would ALLOW.
      undefined,
      id,
    );

  const decided = await call(withRead.adapter, withRead.root, "w1");
  const control = await call(withNothing.adapter, withNothing.root, "w1");

  assert.notEqual(
    decided.decision.decision,
    "ALLOW",
    `a READ_ONLY skill must not authorize a write, got ${JSON.stringify(decided.decision)}`,
  );
  assert.equal(decided.decision.decision, "REQUIRE_APPROVAL", "the tier policy owns the decision");
  assert.equal(
    decided.decision.decision,
    control.decision.decision,
    "the decision must be identical with no skills registered at all",
  );
  // The caller must block anything that is not ALLOW; the Pi `tool_call` hook in
  // the extension does exactly that. See the residual-gap note below.
  assert.notEqual(decided.decision.decision, "ALLOW", "the extension must block this decision");
});

test("B. the declared risk level does not change any decision", async () => {
  // The same call, evaluated against four different catalogs. Every outcome must
  // be identical: a skill's declared risk is a label for the /platform catalog,
  // and it is not an input to policy evaluation.
  const write = { path: "report.md", content: "# Report" };

  for (const mode of ["APPROVAL", "TRUSTED_PROJECT"] as const) {
    const readOnly = await adapterWith([READ_SKILL], mode);
    const declaredWrite = await adapterWith([WRITE_SKILL], mode);
    const both = await adapterWith([READ_SKILL, WRITE_SKILL], mode);
    const none = await adapterWith([], mode);

    const outcomes: string[] = [];
    const variants: { adapter: KernelAdapter; root: string }[] = [readOnly, declaredWrite, both, none];
    for (const [index, variant] of variants.entries()) {
      const { decision } = await variant.adapter.precheckToolCall(
        "write",
        "execute",
        { path: path.join(variant.root, "report.md"), content: write.content },
        undefined,
        `w-${index}`,
      );
      outcomes.push(decision.decision);
    }

    assert.equal(
      new Set(outcomes).size,
      1,
      `in ${mode} mode the catalog changed the decision: ${outcomes.join(", ")}`,
    );
  }
});

test("C. a WRITE skill cannot escape the workspace either", async () => {
  const { adapter, root } = await adapterWith([WRITE_SKILL], "TRUSTED_PROJECT");

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "..", "escape.md"), content: "x" },
    new PiApprovalProvider(true, async () => true),
    "w2",
  );

  assert.equal(decision.decision, "DENY", "trusted mode still denies a boundary escape");
  assert.match((decision as { reason: string }).reason, /path boundary violation/);
});

test("D. a non-interactive run denies a write no matter what any skill declares", async () => {
  const { adapter, root } = await adapterWith([WRITE_SKILL, READ_SKILL]);

  const headless = new PiApprovalProvider(false, async () => true);
  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "report.md"), content: "# Report" },
    headless,
    "w3",
  );

  assert.equal(decision.decision, "DENY", "no UI means fail closed, whatever the catalog says");
  assert.equal(await adapter.beginToolExecution("w3", "write"), undefined);
});

test("E. the descriptor carries no permission surface at all", async () => {
  // The type has riskLevel and no grant/allow/authorize field. This assertion
  // is the structural half of the guarantee: there is nothing to smuggle a
  // permission into, and no property a policy could read as consent.
  const surfaces = Object.keys(WRITE_SKILL).filter((key) => /grant|allow|authori[sz]e|permit|consent|elevat/i.test(key));
  assert.deepEqual(surfaces, [], `unexpected permission-shaped fields: ${surfaces.join(", ")}`);

  // riskLevel is a label, and the catalog formats it as a label.
  assert.equal(skillRiskLevel(WRITE_SKILL), "WRITE");
  assert.equal(skillRiskLevel(READ_SKILL), "READ_ONLY");

  // Skill selection by capability is routing, not authorization: it returns
  // descriptors and cannot influence any policy decision.
  const found = skillsForCapabilities([READ_SKILL, WRITE_SKILL], ["report-authoring"]);
  assert.deepEqual(found, [], "a skill with no matching capability is simply not routed to");
});

/**
 * Attempt versus execution.
 *
 * An execution binds ONLY on ALLOW. A DENY and an unresolved REQUIRE_APPROVAL
 * are both "not authorised", and neither may acquire an execution identity.
 * Pi's `tool_call` hook already blocks non-ALLOW decisions, so the kernel is
 * independently safe rather than relying on the caller to do the right thing.
 */
test("G. an execution binds ONLY on ALLOW", async () => {
  const { adapter, root } = await adapterWith([WRITE_SKILL], "TRUSTED_PROJECT");
  const target = path.join(root, "report.md");

  // ALLOW -> binds.
  const allowed = await adapter.precheckToolCall("write", "execute", { path: target, content: "# Report" }, undefined, "a-allow");
  assert.equal(allowed.decision.decision, "ALLOW");
  assert.ok(await adapter.beginToolExecution("a-allow", "write"), "an ALLOWed call must bind");

  // DENY -> does not bind. The boundary refuses before the tool ever runs.
  const denied = await adapter.precheckToolCall("write", "execute", { path: path.join(root, "..", "escape.md"), content: "x" }, undefined, "a-deny");
  assert.equal(denied.decision.decision, "DENY");
  assert.equal(await adapter.beginToolExecution("a-deny", "write"), undefined, "a DENYed call must never bind");
  assert.equal(adapter.activeExecution("a-deny"), undefined);

  // A result arriving for the denied id must not be recorded as a success.
  const ignored = await adapter.recordToolResult("a-deny", "write", { written: true }, false);
  assert.equal(ignored.status, "INCONCLUSIVE", "a denied call cannot produce a successful result");
});

test("H. an unresolved REQUIRE_APPROVAL does not bind", async () => {
  // Approval mode, no provider supplied: exactly a non-interactive run.
  const { adapter, root } = await adapterWith([WRITE_SKILL], "APPROVAL");
  const target = path.join(root, "report.md");

  const { decision } = await adapter.precheckToolCall("write", "execute", { path: target, content: "# Report" }, undefined, "a-pending");
  assert.equal(decision.decision, "REQUIRE_APPROVAL", "an unauthorised write must not resolve to ALLOW");

  assert.equal(
    await adapter.beginToolExecution("a-pending", "write"),
    undefined,
    "an unresolved approval must fail closed: no execution identity may be acquired",
  );
  assert.equal(adapter.activeExecution("a-pending"), undefined);

  // And the attempt is still visible in the trace, so the refusal is auditable
  // rather than silent.
  const events = adapter.recentEvents(200).map((event) => event.type);
  assert.ok(events.includes("APPROVAL_REQUIRED"), "the attempt must be recorded even though nothing bound");

  // Same call, with an approving provider, does bind. The difference is the
  // authorization, not the tool.
  const approved = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: target, content: "# Report" },
    new PiApprovalProvider(true, async () => true),
    "a-approved",
  );
  assert.equal(approved.decision.decision, "ALLOW");
  assert.ok(await adapter.beginToolExecution("a-approved", "write"), "an approved call binds");
});

test("I. the extension's block contract and the kernel agree", async () => {
  // `.pi/extensions/platform-orchestrator.ts` returns { block: true } for any
  // decision that is not ALLOW. The kernel now refuses the same set
  // independently, so a caller that forgot would still be safe. This asserts
  // the two agree on the DENY and REQUIRE_APPROVAL cases.
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-bind-contract-"));

  for (const [label, mode, expectDecision] of [
    ["denied boundary escape", "TRUSTED_PROJECT", "DENY"],
    ["unresolved approval", "APPROVAL", "REQUIRE_APPROVAL"],
  ] as [string, "TRUSTED_PROJECT" | "APPROVAL", string][]) {
    const { adapter } = await adapterWith([WRITE_SKILL], mode);
    const input = label.startsWith("denied")
      ? { path: path.join(root, "..", "escape.md"), content: "x" }
      : { path: path.join(root, "report.md"), content: "# Report" };
    const id = `c-${label}`;

    const { decision } = await adapter.precheckToolCall("write", "execute", input, undefined, id);
    assert.equal(decision.decision, expectDecision, label);
    // The extension blocks here...
    assert.notEqual(decision.decision, "ALLOW", `${label}: the extension must block`);
    // ...and so does the kernel, without being asked.
    assert.equal(await adapter.beginToolExecution(id, "write"), undefined, `${label}: the kernel must refuse to bind`);
  }
});

test("F. the real project catalog cannot self-authorize either", async () => {
  // report-writer genuinely declares risk: write and genuinely needs the write
  // tool. The point of this test is that even so, the write is still gated.
  const skills = await discoverSkills(path.join(PROJECT_ROOT, "skills"), { knownTools: TOOL_NAMES });
  const reportWriter = skills.find((skill) => skill.name === "report-writer");
  assert.ok(reportWriter, "report-writer must exist");
  assert.equal(skillRiskLevel(reportWriter), "WRITE");

  const { adapter, root } = await adapterWith(skills, "TRUSTED_PROJECT");
  const toolCallId = "w-report";
  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    undefined,
    toolCallId,
  );

  // In trusted mode an in-workspace write is allowed, but note WHO allowed it:
  // the boundary and the tier policy, both of which are independent of the skill.
  assert.equal(decision.decision, "ALLOW");

  // Remove the skill from the catalog and the same call is still allowed: the
  // skill's presence is not the cause of the permission.
  const { adapter: without, root: root2 } = await adapterWith([], "TRUSTED_PROJECT");
  const control = await without.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root2, "reports", "incident.md"), content: "# Findings" },
    undefined,
    toolCallId,
  );
  assert.equal(control.decision.decision, "ALLOW", "the decision is unchanged with no skills registered at all");

  // And the boundary still bites with the skill present.
  const escape = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "..", "escape.md"), content: "x" },
    undefined,
    "w-escape",
  );
  assert.equal(escape.decision.decision, "DENY");
});
