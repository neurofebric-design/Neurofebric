import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPolicy, loadProjectConfig, parseProjectConfig, DEFAULT_PROJECT_CONFIG } from "./project-config.ts";
import { mkdir } from "node:fs/promises";

async function projectWithConfig(contents: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-project-"));
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(path.join(root, ".pi", "neurofebric.json"), JSON.stringify(contents), "utf8");
  return root;
}

test("missing config falls back to the safe approval default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-project-"));
  const config = await loadProjectConfig(root);
  assert.deepEqual(config, DEFAULT_PROJECT_CONFIG);
  assert.equal(config.policyMode, "APPROVAL", "absence of config must never enable trusted mode");
  assert.equal(buildPolicy(config, root).mode, "APPROVAL");
});

test("this project's committed config selects trusted-project mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-project-"));
  const file = path.join(root, ".pi", "neurofebric.json");
  const real = path.resolve(import.meta.dirname, "../../.pi/neurofebric.json");
  const contents = JSON.parse(await (await import("node:fs/promises")).readFile(real, "utf8"));
  assert.equal(contents.policyMode, "TRUSTED_PROJECT", "the repository config must request trusted mode");
  assert.deepEqual(contents.allowedRoots, ["."]);

  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(file, JSON.stringify(contents), "utf8");
  const config = await loadProjectConfig(root);
  const policy = buildPolicy(config, root);
  assert.equal(policy.mode, "TRUSTED_PROJECT");
});

test("parseProjectConfig rejects malformed configuration", () => {
  assert.throws(() => parseProjectConfig("nope", "f"), /expected a JSON object/);
  assert.throws(() => parseProjectConfig({ policyMode: "YOLO" }, "f"), /policyMode must be/);
  assert.throws(() => parseProjectConfig({ allowedRoots: [] }, "f"), /non-empty array/);
  assert.throws(() => parseProjectConfig({ allowedRoots: [1] }, "f"), /non-empty array/);
  assert.equal(parseProjectConfig({}, "f").policyMode, "APPROVAL");
});

test("buildPolicy resolves relative roots against the project directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-project-"));
  const config = { policyMode: "TRUSTED_PROJECT" as const, allowedRoots: [".", "workspace"] };
  const policy = buildPolicy(config, root);
  assert.equal(policy.mode, "TRUSTED_PROJECT");
  // The resolved boundary must accept a path inside the project.
  const decision = policy.evaluate({
    taskId: "t",
    tool: {
      name: "read", version: "1", description: "", inputSchema: {}, outputSchema: {},
      capabilities: [], permissions: [], riskLevel: "READ_ONLY", timeoutMs: 1,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      idempotency: "IDEMPOTENT", sideEffect: "PURE",
    },
    operation: "execute",
    input: { path: "workspace/file.txt" },
  });
  assert.equal(decision.decision, "ALLOW");
});
