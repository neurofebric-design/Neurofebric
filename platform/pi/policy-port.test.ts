import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { NeurofebricProjectConfig } from "./project-config.ts";

/**
 * The legacy policy engine, ported. Every assertion here corresponds to a rule
 * in `policies/default_policy.yaml` and is exercised through the SAME choke
 * point Pi uses: `KernelAdapter.precheckToolCall`, which the extension's
 * `tool_call` handler calls.
 *
 * The mapping and the four places it is not one-to-one are in
 * docs/POLICY_PORT.md.
 */

const TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "write", "edit"];

const TRUSTED: NeurofebricProjectConfig = { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] };
const APPROVAL: NeurofebricProjectConfig = { policyMode: "APPROVAL", allowedRoots: ["."] };

/** The legacy rules, expressed in the kernel's config shape. */
const LEGACY_RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  deniedContentPatterns: ["rm -rf", "format c:", "api_key", "password"],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-policy-port-"));
}

async function adapterWith(
  root: string,
  overrides: Record<string, unknown> = {},
  config: NeurofebricProjectConfig = TRUSTED,
) {
  await mkdir(path.join(root, "reports"), { recursive: true });
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...LEGACY_RULES, ...overrides }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(config, root, policyConfig));
  for (const name of TOOL_NAMES) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  await adapter.beginTask("do the work", "do the work");
  return { adapter, policyConfig };
}

test("1. deny beats allow: a tool on both lists is denied", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, {
    allowedTools: ["read", "bash", "write"],
    deniedTools: ["bash"],
  });

  const denied = await adapter.precheckToolCall("bash", "execute", { command: "npm test" }, undefined, "b1");
  assert.equal(denied.decision.decision, "DENY");
  assert.match((denied.decision as { reason: string }).reason, /'bash' is in deniedTools/);

  // A tool that is only on the allow list still passes the name check.
  const allowed = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "r1");
  assert.equal(allowed.decision.decision, "ALLOW");

  // A tool on neither list is denied, because the allow list is non-empty.
  const absent = await adapter.precheckToolCall("grep", "execute", { pattern: "x" }, undefined, "g1");
  assert.equal(absent.decision.decision, "DENY");
  assert.match((absent.decision as { reason: string }).reason, /not in allowedTools/);
});

test("2. a write inside the workspace is allowed; a write outside it is denied with a reason", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  const inside = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    undefined,
    "w1",
  );
  assert.equal(inside.decision.decision, "ALLOW", "a write inside the workspace is ordinary work");

  const outside: [string, unknown][] = [
    [path.join(path.dirname(root), "escape.md"), "absolute path outside the root"],
    [path.join(root, "..", "escape.md"), "parent traversal"],
    [path.join(root, "reports", "..", "..", "escape.md"), "nested traversal"],
  ];

  for (const [candidate, label] of outside) {
    const { decision } = await adapter.precheckToolCall("write", "execute", { path: candidate, content: "x" }, undefined, `o-${label}`);
    assert.equal(decision.decision, "DENY", `write outside the workspace (${label}) must be denied`);
    assert.match((decision as { reason: string }).reason, /path boundary violation/);
  }

  // An approving dialog cannot override a boundary denial.
  const escalated = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "..", "escape.md"), content: "x" },
    { requestApproval: async () => true },
    "o-approved",
  );
  assert.equal(escalated.decision.decision, "DENY");
  assert.equal(await adapter.beginToolExecution("o-approved", "write"), undefined);

  // A file rule placed ABOVE the catch-all locks a subtree down: first match wins.
  const { adapter: locked } = await adapterWith(root, {
    fileRules: [
      { pattern: "reports/private/**", read: "deny", write: "deny" },
      { pattern: "**", read: "allow", write: "allow" },
    ],
  });
  const blocked = await locked.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "private", "notes.md"), content: "x" },
    undefined,
    "w2",
  );
  assert.equal(blocked.decision.decision, "DENY");
  assert.match((blocked.decision as { reason: string }).reason, /path rule 'reports\/private\/\*\*' denies write/);
});

test("3. a content pattern blocks an input containing rm -rf", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  const cases: [string, unknown, string][] = [
    ["bash", { command: "rm -rf node_modules" }, "shell command"],
    ["bash", { command: "echo hi && RM -RF /tmp/x" }, "case-insensitive"],
    ["write", { path: "notes.md", content: "never run rm -rf here" }, "nested argument"],
    ["read", { path: "docs/rm -rf.md" }, "a path argument"],
  ];

  for (const [tool, input, label] of cases) {
    const { decision } = await adapter.precheckToolCall(tool, "execute", input, undefined, `c-${label}`);
    assert.equal(decision.decision, "DENY", `${label} must be denied`);
    assert.match((decision as { reason: string }).reason, /denied content pattern matched: 'rm -rf'/);
  }

  // Every other legacy pattern is enforced too.
  for (const [pattern, input] of [
    ["format c:", { command: "format c: /now" }],
    ["api_key", { command: "curl -d api_key=abc" }],
    ["password", { command: "cat password.txt" }],
  ] as [string, unknown][]) {
    const { decision } = await adapter.precheckToolCall("bash", "execute", input, undefined, `p-${pattern}`);
    assert.equal(decision.decision, "DENY", `pattern '${pattern}' must be enforced`);
    assert.match((decision as { reason: string }).reason, new RegExp(`denied content pattern matched: '${pattern}'`));
  }

  // An innocent call is untouched: the rules do not fire on ordinary work.
  const fine = await adapter.precheckToolCall("bash", "execute", { command: "npm test" }, undefined, "c-fine");
  assert.equal(fine.decision.decision, "ALLOW");
});

test("4. the 41st tool call in a task is denied", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  // The first 40 calls are permitted, exactly as max_tool_calls_per_run: 40 was.
  for (let call = 1; call <= 40; call += 1) {
    const { decision } = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, `call-${call}`);
    assert.equal(decision.decision, "ALLOW", `call ${call} of 40 must be allowed`);
  }

  const overflow = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "call-41");
  assert.equal(overflow.decision.decision, "DENY", "the 41st call must be denied");
  assert.match((overflow.decision as { reason: string }).reason, /maxToolCallsPerTask exceeded \(40\)/);
  assert.equal(await adapter.beginToolExecution("call-41", "read"), undefined, "the refused call must not execute");

  // on_violation is block, so the task itself is untouched and can continue.
  assert.equal(adapter.currentTask!.status, "PLANNING");
  assert.equal(adapter.currentTask!.failureReason, undefined);

  // A NEW task gets a fresh budget, matching the legacy per-run counter.
  await adapter.beginTask("second task", "second task");
  const fresh = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "fresh-1");
  assert.equal(fresh.decision.decision, "ALLOW", "a new task must not inherit the previous task's budget");
});

test("4b. the file-write and write-size limits are enforced too", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, {
    limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 3, maxBytesPerWrite: 64 },
  });

  for (let call = 1; call <= 3; call += 1) {
    const { decision } = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, `w-${call}`);
    assert.equal(decision.decision, "ALLOW", `write ${call} of 3 must be allowed`);
  }
  const fourth = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, "w-4");
  assert.equal(fourth.decision.decision, "DENY");
  assert.match((fourth.decision as { reason: string }).reason, /maxFileWritesPerTask exceeded \(3\)/);

  // Write size is a separate limit, so it gets a task with write budget left.
  const { adapter: sizing } = await adapterWith(root, {
    limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 64 },
  });
  const tooBig = await sizing.precheckToolCall(
    "write",
    "execute",
    { path: "big.md", content: "x".repeat(200) },
    undefined,
    "w-big",
  );
  assert.equal(tooBig.decision.decision, "DENY");
  assert.match((tooBig.decision as { reason: string }).reason, /maxBytesPerWrite exceeded/);

  const justUnder = await sizing.precheckToolCall(
    "write",
    "execute",
    { path: "ok.md", content: "x".repeat(60) },
    undefined,
    "w-ok",
  );
  assert.equal(justUnder.decision.decision, "ALLOW", "a write under the byte limit is unaffected");
});

test("5. on_violation: abort terminates the task and the trace shows why", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, { onViolation: "abort" });

  // An innocent call still works before the violation.
  assert.equal((await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "a1")).decision.decision, "ALLOW");

  const violation = await adapter.precheckToolCall("bash", "execute", { command: "rm -rf node_modules" }, undefined, "a2");
  assert.equal(violation.decision.decision, "DENY");
  assert.equal((violation.decision as { violation?: string }).violation, "abort");

  // The task is terminated, not merely blocked.
  assert.equal(adapter.currentTask!.status, "FAILED");
  assert.match(adapter.currentTask!.failureReason!, /rm -rf/);

  // The termination is visible in the trace, with the rule and the reason.
  const events = adapter.recentEvents(200);
  const violationEvent = events.find((entry) => entry.type === "POLICY_VIOLATION");
  assert.ok(violationEvent, "a POLICY_VIOLATION event must be recorded");
  assert.equal(violationEvent!.payload.tool, "bash");
  assert.equal(violationEvent!.payload.onViolation, "abort");
  assert.match(String(violationEvent!.payload.reason), /rm -rf/);
  assert.ok(events.some((entry) => entry.type === "POLICY_ABORTED"), "the abort itself must be recorded");
  const failed = events.find((entry) => entry.type === "TASK_FAILED");
  assert.ok(failed, "the task failure must be recorded");
  assert.match(String(failed!.payload.reason), /Policy abort/);

  // Further calls are refused, however innocent they are, and cannot resurrect it.
  const after = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "a3");
  assert.equal(after.decision.decision, "DENY");
  assert.match((after.decision as { reason: string }).reason, /Task is FAILED/);
  assert.equal(await adapter.beginToolExecution("a3", "read"), undefined);
  assert.equal(adapter.currentTask!.status, "FAILED");

  // Finalising an aborted task reports it as-is rather than completing or throwing.
  const finished = await adapter.finishTask({ done: true });
  assert.equal(finished.status, "FAILED");
});

test("6. the declarative rules can only remove a permission, never add one", async () => {
  const root = await sandbox();

  // A maximally permissive config still cannot turn a write into an automatic
  // approval: in APPROVAL mode the tier policy underneath still escalates.
  const permissive: PolicyConfig = parsePolicyConfig({
    ...LEGACY_RULES,
    deniedTools: [],
    allowedTools: [],
    fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "APPROVAL", allowedRoots: ["."] }, root, permissive));
  for (const name of TOOL_NAMES) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("write a report", "write a report");

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "a.md"), content: "x" },
    undefined,
    "p1",
  );
  assert.equal(decision.decision, "REQUIRE_APPROVAL", "the tier policy still owns approval");

  // And in trusted mode the same config leaves the workspace boundary intact.
  const trusted = new KernelAdapter();
  trusted.setPolicy(buildPolicy({ ...TRUSTED, allowedRoots: [root] }, root, permissive));
  for (const name of TOOL_NAMES) trusted.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await trusted.beginTask("write a report", "write a report");
  const escape = await trusted.precheckToolCall(
    "write",
    "execute",
    { path: path.join(path.dirname(root), "escape.md"), content: "x" },
    undefined,
    "p2",
  );
  assert.equal(escape.decision.decision, "DENY");
});

test("7. the committed project policy file is valid and loadable", async () => {
  const projectRoot = path.resolve(import.meta.dirname, "../..");
  const { loadPolicyConfig } = await import("../core/policy-config.ts");
  const config = await loadPolicyConfig(projectRoot);

  assert.ok(config, ".pi/neurofebric-policy.json must exist and parse");
  assert.equal(config!.version, 1);
  assert.equal(config!.limits.maxToolCallsPerTask, 40, "the legacy limit is preserved");
  assert.equal(config!.limits.maxFileWritesPerTask, 10);
  assert.equal(config!.limits.maxBytesPerWrite, 2_000_000);
  assert.deepEqual(config!.deniedContentPatterns, ["rm -rf", "format c:", "api_key", "password"]);
  assert.equal(config!.onViolation, "block");
});
