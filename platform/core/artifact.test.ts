import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyArtifactKind,
  createArtifact,
  declaredArtifactReferences,
  toolProducesArtifacts,
  verifyArtifact,
  verifyArtifacts,
} from "./artifact.ts";
import { WorkspaceBoundary } from "./workspace.ts";
import { toolDescriptorFromPi } from "../pi/tool-adapter.ts";
import type { ToolDescriptor } from "./types.ts";

const write = toolDescriptorFromPi({ name: "write", description: "Write a file" });
const read = toolDescriptorFromPi({ name: "read", description: "Read a file" });
const bash = toolDescriptorFromPi({ name: "bash", description: "Run a command" });
const grep = toolDescriptorFromPi({ name: "grep", description: "Search" });

async function sandbox(): Promise<{ root: string; boundary: WorkspaceBoundary }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-artifact-"));
  return { root, boundary: new WorkspaceBoundary([root]) };
}

function artifact(reference: string, descriptor: ToolDescriptor = write) {
  return createArtifact({ reference, descriptor, taskId: "t1", stepId: "s1", executionId: "e1" });
}

// ---------------------------------------------------------------------------
// Kind classification is generic and extensible
// ---------------------------------------------------------------------------

test("artifact kind is classified from the reference, not a domain special case", () => {
  assert.equal(classifyArtifactKind("a/b.json"), "structured-data");
  assert.equal(classifyArtifactKind("a/b.csv"), "structured-data");
  assert.equal(classifyArtifactKind("img/out.png"), "image");
  assert.equal(classifyArtifactKind("clip/out.mp4"), "video");
  assert.equal(classifyArtifactKind("audio/out.mp3"), "audio");
  assert.equal(classifyArtifactKind("src/app.ts"), "code");
  assert.equal(classifyArtifactKind("docs/report.md"), "document");
  assert.equal(classifyArtifactKind("out/deck.pptx"), "report");
  assert.equal(classifyArtifactKind("out/thing.unknownext"), "file");
  assert.equal(classifyArtifactKind("out/noext"), "file");
});

// ---------------------------------------------------------------------------
// Descriptor-driven declaration — no hard-coded tool names
// ---------------------------------------------------------------------------

test("only side-effecting write tools declare artifacts", () => {
  assert.equal(toolProducesArtifacts(write), true);
  assert.equal(toolProducesArtifacts(read), false, "a read consumes an input; it produces nothing");
  assert.equal(toolProducesArtifacts(grep), false);
  assert.equal(toolProducesArtifacts(bash), false, "a shell command must not be guessed at");
  assert.deepEqual(declaredArtifactReferences(read, { path: "a.txt" }), []);
  assert.deepEqual(declaredArtifactReferences(bash, { command: "npm run build" }), []);
  assert.deepEqual(declaredArtifactReferences(write, { path: "out.txt", content: "x" }), ["out.txt"]);
  assert.deepEqual(declaredArtifactReferences(write, { path: "../escape.txt" }), ["../escape.txt"]);
});

test("an unregistered future tool is handled by classification alone", () => {
  const mcpRender: ToolDescriptor = {
    ...write, name: "render_video", version: "1", riskLevel: "WRITE", sideEffect: "SIDE_EFFECTING", idempotency: "IDEMPOTENT",
  };
  assert.deepEqual(declaredArtifactReferences(mcpRender, { outputPath: "out/clip.mp4" }), ["out/clip.mp4"]);
});

// ---------------------------------------------------------------------------
// Verification: success, missing, invalid, unverified
// ---------------------------------------------------------------------------

test("a real file is VERIFIED with size and content hash", async () => {
  const { root, boundary } = await sandbox();
  const target = path.join(root, "out.txt");
  await writeFile(target, "Neurofebric artifact test", "utf8");

  const result = await verifyArtifact(artifact(target), { boundary });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.checks.exists, true);
  assert.equal(result.checks.withinBoundary, true);
  assert.equal(result.checks.nonEmpty, true);
  assert.equal(result.sizeBytes, Buffer.byteLength("Neurofebric artifact test"));
  assert.match(result.sha256!, /^[0-9a-f]{64}$/);
});

test("a declared artifact that does not exist is INVALID, not a pass", async () => {
  const { root, boundary } = await sandbox();
  const result = await verifyArtifact(artifact(path.join(root, "never-written.txt")), { boundary });
  assert.equal(result.status, "INVALID");
  assert.equal(result.checks.exists, false);
  assert.match(result.reason!, /does not exist/);
});

test("an empty file is INVALID", async () => {
  const { root, boundary } = await sandbox();
  const target = path.join(root, "empty.txt");
  await writeFile(target, "", "utf8");
  const result = await verifyArtifact(artifact(target), { boundary });
  assert.equal(result.status, "INVALID");
  assert.match(result.reason!, /empty/);
});

test("an artifact outside the boundary is INVALID", async () => {
  const { root, boundary } = await sandbox();
  const outside = path.join(path.dirname(root), "outside.txt");
  await writeFile(outside, "secret", "utf8");
  try {
    const result = await verifyArtifact(artifact(outside), { boundary });
    assert.equal(result.status, "INVALID");
    assert.match(result.reason!, /outside the allowed workspace/);
  } finally {
    const { unlink } = await import("node:fs/promises");
    await unlink(outside).catch(() => {});
  }
});

test("a kind mismatch is INVALID", async () => {
  const { root, boundary } = await sandbox();
  await mkdir(path.join(root, "assets"), { recursive: true });
  const claimed = { ...artifact(path.join(root, "assets")), type: "structured-data" };
  const result = await verifyArtifact(claimed, { boundary });
  assert.equal(result.status, "INVALID");
  assert.match(result.reason!, /kind mismatch/);
});

test("a directory artifact is verified without content hashing", async () => {
  const { root, boundary } = await sandbox();
  await mkdir(path.join(root, "dist"), { recursive: true });
  const result = await verifyArtifact({ ...artifact(path.join(root, "dist")), type: "directory" }, { boundary });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.kind, "directory");
});

test("a remote reference is UNVERIFIED, never silently VERIFIED", async () => {
  const { boundary } = await sandbox();
  const result = await verifyArtifact(artifact("https://cdn.example.com/out.png"), { boundary });
  assert.equal(result.status, "UNVERIFIED");
  assert.notEqual(result.status, "VERIFIED");
});

test("malformed artifact references fail closed", async () => {
  const { boundary } = await sandbox();
  for (const reference of ["", "   ", "a\0b", 42 as unknown as string]) {
    const result = await verifyArtifact(artifact(reference), { boundary });
    assert.notEqual(result.status, "VERIFIED", `must not verify: ${JSON.stringify(reference)}`);
  }
});

test("verifyArtifacts stamps trust and only reports allVerified when every artifact passes", async () => {
  const { root, boundary } = await sandbox();
  await writeFile(path.join(root, "good.txt"), "content", "utf8");

  const all = await verifyArtifacts([artifact(path.join(root, "good.txt"))], { boundary });
  assert.equal(all.allVerified, true);
  assert.equal(all.artifacts[0].trust, "VERIFIED");

  const partial = await verifyArtifacts([
    artifact(path.join(root, "good.txt")),
    artifact(path.join(root, "missing.txt")),
  ], { boundary });
  assert.equal(partial.allVerified, false, "one bad artifact must block the batch");
  assert.equal(partial.invalid.length, 1);
  assert.equal(partial.artifacts.find((a) => a.reference.includes("missing.txt"))?.trust, "INVALID");

  assert.equal((await verifyArtifacts([], { boundary })).allVerified, false, "no artifacts is not a verified batch");
});

test("artifact identity is stable for the same execution and reference", () => {
  const a = artifact("out.txt");
  const b = artifact("out.txt");
  assert.equal(a.artifactId, b.artifactId);
  assert.equal(createArtifact({ reference: "other.txt", descriptor: write, taskId: "t1", stepId: "s1", executionId: "e1" }).artifactId !== a.artifactId, true);
  assert.equal(a.trust, "UNVERIFIED", "an artifact starts untrusted until verified");
});
