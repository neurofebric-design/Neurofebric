import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { WorkspaceBoundary } from "../core/index.ts";

/**
 * The hallucination guard.
 *
 * Pi reports what a tool said, not what happened on disk. These tests pin the
 * rule that a declared output must actually exist before the task is allowed
 * to complete.
 *
 * AUTHORIZATION PRECONDITION. An execution binds only on ALLOW, so these tests
 * install a policy with an approving provider. That stands in for an operator
 * who approved the specific call; it does not bypass anything else. In
 * particular the out-of-workspace case below is still authorized to *run* and
 * is still marked INVALID by artifact verification, which is the point of having
 * two independent layers. Authorization and verification are tested separately,
 * in write-approval.test.ts and policy-port.test.ts respectively.
 */

const WRITE = toolDescriptorFromPi({ name: "write", description: "Write a file" });
const READ = toolDescriptorFromPi({ name: "read", description: "Read" });
const BASH = toolDescriptorFromPi({ name: "bash", description: "Run a command" });

/** An operator who approved the call under test. See the note above. */
const APPROVED = { requestApproval: async () => true };

async function adapterIn(root: string) {
  const adapter = new KernelAdapter({ boundary: new WorkspaceBoundary([root]) });
  adapter.registerTools([WRITE, READ, BASH]);
  await adapter.beginTask("produce an output", "produce an output");
  return adapter;
}

const types = (adapter: KernelAdapter) => adapter.recentEvents(500).map((e) => e.type);

test("a write that really produced its declared file is VERIFIED and completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const target = path.join(root, "report.md");
  await writeFile(target, "# Report\n", "utf8");

  const adapter = await adapterIn(root);
  await adapter.precheckToolCall("write", "execute", { path: target, content: "# Report\n" }, APPROVED, "c1");
  adapter.declareToolOutputs("c1", "write", { path: target });
  assert.ok(await adapter.beginToolExecution("c1", "write"));

  const validation = await adapter.recordToolResult("c1", "write", { written: true }, false);
  assert.equal(validation.status, "VALID");
  assert.equal(validation.validator, "artifact-verification");
  assert.match(validation.message, /verified on disk/);

  const [produced] = adapter.artifacts;
  assert.equal(produced!.trust, "VERIFIED");
  assert.equal(produced!.type, "document");
  assert.match(produced!.verification!.sha256!, /^[0-9a-f]{64}$/);

  assert.ok(types(adapter).includes("ARTIFACT_VERIFIED"));
  assert.equal((await adapter.finishTask({ done: true })).status, "COMPLETED");
});

test("HALLUCINATION: a write reported successful but no file exists must NOT complete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const target = path.join(root, "never-created.png");

  const adapter = await adapterIn(root);
  await adapter.precheckToolCall("write", "execute", { path: target, content: "data" }, APPROVED, "c1");
  adapter.declareToolOutputs("c1", "write", { path: target });
  await adapter.beginToolExecution("c1", "write");

  // The tool claims success. The file was never written.
  const validation = await adapter.recordToolResult("c1", "write", { written: true }, false);
  assert.equal(validation.status, "INVALID", "success without a real artifact is not a pass");
  assert.equal(validation.validator, "artifact-verification");
  assert.match(validation.message, /failed verification/);

  assert.equal(adapter.artifacts[0]!.trust, "INVALID");
  assert.ok(types(adapter).includes("ARTIFACT_INVALID"));

  const task = await adapter.finishTask({ claim: "image created" });
  assert.notEqual(task.status, "COMPLETED", "an unverified claim must not be delivered as complete");
  assert.equal(task.finalResult, undefined);
});

test("a declared artifact outside the workspace is INVALID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const outside = path.join(path.dirname(root), "escaped.txt");
  await writeFile(outside, "nope", "utf8");
  try {
    const adapter = await adapterIn(root);
    await adapter.precheckToolCall("write", "execute", { path: outside }, APPROVED, "c1");
    adapter.declareToolOutputs("c1", "write", { path: outside });
    await adapter.beginToolExecution("c1", "write");
    const validation = await adapter.recordToolResult("c1", "write", { ok: true }, false);
    assert.equal(validation.status, "INVALID");
    assert.match(validation.message, /outside the allowed workspace/);
  } finally {
    const { unlink } = await import("node:fs/promises");
    await unlink(outside).catch(() => {});
  }
});

test("read-only tools and shell commands declare no artifacts and do not block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const adapter = await adapterIn(root);

  // Reading an input is evidence, not a produced artifact.
  await adapter.precheckToolCall("read", "execute", { path: path.join(root, "input.txt") }, undefined, "c1");
  assert.deepEqual(adapter.declareToolOutputs("c1", "read", { path: path.join(root, "input.txt") }), []);
  await adapter.beginToolExecution("c1", "read");
  const readValidation = await adapter.recordToolResult("c1", "read", { content: "x" }, false);
  assert.equal(readValidation.status, "VALID");
  assert.equal(readValidation.validator, "pi-result");
  assert.equal(adapter.artifacts.length, 0, "a read must not invent an artifact");
  assert.equal((await adapter.finishTask({})).status, "COMPLETED");

  // Same for a shell command: no guessing which paths are outputs.
  const adapter2 = await adapterIn(root);
  await adapter2.precheckToolCall("bash", "execute", { command: "npm test" }, APPROVED, "b1");
  assert.deepEqual(adapter2.declareToolOutputs("b1", "bash", { command: "npm test" }), []);
  await adapter2.beginToolExecution("b1", "bash");
  assert.equal((await adapter2.recordToolResult("b1", "bash", { exitCode: 0 }, false)).status, "VALID");
  assert.equal(adapter2.artifacts.length, 0);
  assert.equal((await adapter2.finishTask({})).status, "COMPLETED");
});

test("a failed artifact in one parallel branch is not papered over by a passing sibling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const real = path.join(root, "good.txt");
  const missing = path.join(root, "missing.txt");
  await writeFile(real, "ok", "utf8");

  const adapter = await adapterIn(root);
  // Two parallel writes. c1 is the FAILING one and settles first, so the last
  // result to settle is the passing one — the case that a naive implementation
  // would complete on.
  await adapter.precheckToolCall("write", "execute", { path: missing }, APPROVED, "c1");
  await adapter.precheckToolCall("write", "execute", { path: real }, APPROVED, "c2");
  adapter.declareToolOutputs("c1", "write", { path: missing });
  adapter.declareToolOutputs("c2", "write", { path: real });
  await adapter.beginToolExecution("c1", "write");
  await adapter.beginToolExecution("c2", "write");

  assert.equal((await adapter.recordToolResult("c1", "write", { ok: true }, false)).status, "INVALID");
  const last = await adapter.recordToolResult("c2", "write", { ok: true }, false);
  assert.equal(last.status, "VALID", "the settling result is itself valid");

  const task = await adapter.finishTask({});
  assert.notEqual(task.status, "COMPLETED", "partial failure in the same attempt must block completion");
  assert.equal(task.finalResult, undefined);
});

test("recovery after a failed artifact still allows a later successful round", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");

  const adapter = await adapterIn(root);
  await adapter.precheckToolCall("write", "execute", { path: first }, APPROVED, "c1");
  adapter.declareToolOutputs("c1", "write", { path: first });
  await adapter.beginToolExecution("c1", "write");
  assert.equal((await adapter.recordToolResult("c1", "write", { ok: true }, false)).status, "INVALID");

  // Recovery lands on a real planning state; the retry produces the file.
  await writeFile(second, "finally", "utf8");
  await adapter.precheckToolCall("write", "execute", { path: second }, APPROVED, "c2");
  adapter.declareToolOutputs("c2", "write", { path: second });
  assert.ok(await adapter.beginToolExecution("c2", "write"), "recovery must admit the retry");
  assert.equal((await adapter.recordToolResult("c2", "write", { ok: true }, false)).status, "VALID");

  assert.equal((await adapter.finishTask({})).status, "COMPLETED", "a superseded failure must not block forever");
});

test("a tool error is still INVALID regardless of artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const adapter = await adapterIn(root);
  await adapter.beginToolExecution("c1", "read");
  const validation = await adapter.recordToolResult("c1", "read", undefined, true);
  assert.equal(validation.status, "INVALID");
  assert.equal(validation.validator, "pi-result");
});

test("provenance records only what actually ran", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-art-e2e-"));
  const target = path.join(root, "out.json");
  await writeFile(target, "{}", "utf8");
  const adapter = await adapterIn(root);
  await adapter.precheckToolCall("write", "execute", { path: target }, APPROVED, "c1");
  adapter.declareToolOutputs("c1", "write", { path: target });
  await adapter.beginToolExecution("c1", "write");
  await adapter.recordToolResult("c1", "write", { ok: true }, false);

  const events = adapter.recentEvents(500);
  const verified = events.find((e) => e.type === "ARTIFACT_VERIFIED");
  assert.ok(verified, "verification must be observable in the trace");
  assert.equal(verified!.payload.producer, "write");
  assert.equal(verified!.payload.kind, "structured-data");
  assert.equal(verified!.payload.status, "VERIFIED");
  assert.ok(adapter.artifacts[0]!.artifactId, "artifact id is stable for downstream linkage");
});
