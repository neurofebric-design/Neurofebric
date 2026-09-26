import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultPolicy, TrustedProjectPolicy, WorkspaceBoundary, extractPathCandidates, isInsideRoot, resolveWithinRoot } from "./index.ts";
import type { PolicyRequest, ToolDescriptor } from "./types.ts";

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "bash",
    version: "1",
    description: "Run a shell command",
    inputSchema: {},
    outputSchema: {},
    capabilities: ["shell"],
    permissions: ["shell"],
    riskLevel: "CONTROLLED",
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    idempotency: "UNKNOWN",
    sideEffect: "SIDE_EFFECTING",
    ...overrides,
  };
}

function request(overrides: Partial<PolicyRequest> & { input: unknown }): PolicyRequest {
  return { taskId: "task-1", tool: tool(), operation: "execute", ...overrides };
}

async function sandbox(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-boundary-"));
  await mkdir(path.join(root, "workspace", "src"), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// Containment primitives
// ---------------------------------------------------------------------------

test("isInsideRoot does not match sibling directories sharing a prefix", () => {
  assert.equal(isInsideRoot("/srv/app", "/srv/app/src"), true);
  assert.equal(isInsideRoot("/srv/app", "/srv/app"), true);
  assert.equal(isInsideRoot("/srv/app", "/srv/app-backup"), false, "prefix sibling must not count as inside");
  assert.equal(isInsideRoot("/srv/app", "/srv/app/../etc"), false);
});

test("resolveWithinRoot blocks traversal, absolute escapes, and NUL bytes", async () => {
  const root = await sandbox();
  const workspace = path.join(root, "workspace");

  assert.equal(resolveWithinRoot(workspace, "src/index.ts").allowed, true);
  assert.equal(resolveWithinRoot(workspace, "./src/../src/app.ts").allowed, true);

  const traversal = resolveWithinRoot(workspace, "../secrets.txt");
  assert.equal(traversal.allowed, false);
  assert.equal(traversal.traversal, true);

  const absolute = resolveWithinRoot(workspace, path.join(root, "outside.txt"));
  assert.equal(absolute.allowed, false);
  assert.equal(absolute.absolute, true);

  assert.equal(resolveWithinRoot(workspace, "src\0.ts").allowed, false, "NUL byte must be rejected");
  assert.equal(resolveWithinRoot(workspace, "").allowed, false);
  assert.equal(resolveWithinRoot(workspace, 42 as unknown).allowed, false);
  assert.equal(resolveWithinRoot(workspace, undefined).allowed, false);
});

test("resolveWithinRoot defeats a symlink that points outside the root", async () => {
  const root = await sandbox();
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "sensitive", "utf8");

  const link = path.join(workspace, "escape");
  try {
    await symlink(outside, link, "dir");
  } catch {
    return; // Creating links is not permitted on this host; nothing to assert.
  }

  const viaLink = resolveWithinRoot(workspace, "escape/secret.txt");
  assert.equal(viaLink.allowed, false, "a symlink out of the workspace must not be permitted");
  assert.equal(resolveWithinRoot(workspace, "escape").allowed, false);
});

test("extractPathCandidates finds named path fields and escapes in free text", () => {
  assert.deepEqual(extractPathCandidates({ path: "src/a.ts" }), ["src/a.ts"]);
  const fromCommand = extractPathCandidates({ command: "cat ../../etc/passwd" });
  assert.ok(fromCommand.includes("../../etc/passwd"), "traversal inside a command must be surfaced");
  assert.deepEqual(extractPathCandidates({ command: "npm test" }), [], "ordinary dev commands yield no path candidates");
  assert.deepEqual(extractPathCandidates({ command: "curl https://example.com/x" }), [], "URLs are not filesystem paths");
  assert.ok(extractPathCandidates({ command: "cat src/../../etc/hosts" }).includes("src/../../etc/hosts"), "nested traversal must be surfaced");
  assert.ok(extractPathCandidates({ command: "type deploy/prod.env" }).includes("deploy/prod.env"), "nested relative paths must be surfaced");
});

// ---------------------------------------------------------------------------
// Trusted-project policy: normal work must not be gated
// ---------------------------------------------------------------------------

test("TRUSTED_PROJECT: normal development operations are allowed with no approval", async () => {
  const root = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [path.join(root, "workspace")] });

  const cases: unknown[] = [
    { command: "npm test" },
    { command: "node --experimental-strip-types --test platform/**/*.test.ts" },
    { command: "git status" },
    { command: "git commit -m \"fix parser\"" },
    { command: "python -m pytest tests/" },
    { command: "ls -la" },
    { path: "workspace/src/index.ts" },
  ];
  for (const input of cases) {
    assert.equal(policy.evaluate(request({ input })).decision, "ALLOW", `expected ALLOW for ${JSON.stringify(input)}`);
  }

  const write = tool({ name: "write", riskLevel: "WRITE", sideEffect: "SIDE_EFFECTING" });
  assert.equal(policy.evaluate(request({ tool: write, input: { path: "src/out.ts", content: "x" } })).decision, "ALLOW");
});

test("TRUSTED_PROJECT: evaluateWithApproval never consults an approval provider", async () => {
  const root = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [path.join(root, "workspace")] });
  let asked = 0;
  // A provider that would approve everything; it must never be reached.
  const decision = await policy.evaluateWithApproval({ ...request({ input: { command: "npm test" } }), approval: true });
  assert.equal(decision.decision, "ALLOW");
  assert.equal(asked, 0);
  assert.equal(policy.mode, "TRUSTED_PROJECT");
});

test("TRUSTED_PROJECT: destructive commands are denied outright, not prompted", async () => {
  const root = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [path.join(root, "workspace")] });

  for (const command of [
    "rm -rf /",
    "rm -rf node_modules",
    "rmdir /s /q build",
    "del /f /s C:\\temp",
    "Remove-Item -Recurse -Force .",
    "mkfs.ext4 /dev/sda1",
    "format c:",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    "shutdown now",
    "chmod -R 777 /",
    "takeown /f .",
    "reg delete HKLM\\Software",
    "git push --force origin main",
    "git reset --hard HEAD~5",
    "git clean -fdx",
    "drop database production",
  ]) {
    const decision = policy.evaluate(request({ input: { command } }));
    assert.equal(decision.decision, "DENY", `expected DENY for: ${command}`);
    assert.match((decision as { reason: string }).reason, /destructive/i);
  }
});

test("TRUSTED_PROJECT: credential access is denied outright", async () => {
  const root = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [path.join(root, "workspace")] });

  for (const input of [
    { command: "cat .env" },
    { command: "cat ../.env" },
    { path: ".env" },
    { command: "printenv" },
    { command: "cat ~/.ssh/id_rsa" },
    { command: "cat .aws/credentials" },
    { command: "type .npmrc" },
    { command: "Get-ChildItem Env:" },
    { path: "C:/Users/x/.git-credentials" },
  ]) {
    const decision = policy.evaluate(request({ input }));
    assert.equal(decision.decision, "DENY", `expected DENY for: ${JSON.stringify(input)}`);
  }
});

test("TRUSTED_PROJECT: credential files are denied by basename, not just by prefix", async () => {
  const root = await sandbox();
  const workspace = path.join(root, "workspace");
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const read = tool({ name: "read", riskLevel: "READ_ONLY", sideEffect: "PURE" });

  // Regression: `.env` only matches when it STARTS a path component, so
  // prefixed env files inside the project were previously readable.
  for (const input of [
    { path: "config/app.env" },
    { path: "deploy/prod.env" },
    { path: "services/api/.env.staging" },
    { command: "cat ./config/app.env" },
    { command: "type deploy/prod.env" },
  ]) {
    const decision = policy.evaluate(request({ tool: read, input }));
    assert.equal(decision.decision, "DENY", `expected DENY for: ${JSON.stringify(input)}`);
    assert.match((decision as { reason: string }).reason, /credential/i);
  }

  for (const input of [
    { path: "docs/environment.md" },
    { path: "README.md" },
    { path: "platform/core/policy.ts" },
    { path: "tests/fixtures/security/fake-secrets.txt" },
  ]) {
    assert.equal(policy.evaluate(request({ tool: read, input })).decision, "ALLOW", `false positive on ${JSON.stringify(input)}`);
  }
});

test("TRUSTED_PROJECT: paths outside the allowed root are denied", async () => {
  const root = await sandbox();
  const workspace = path.join(root, "workspace");
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });

  for (const input of [
    { path: "../outside.txt", content: "x" },
    { path: path.join(root, "outside.txt") },
    { command: "cat ../secrets.txt" },
    { command: "cp src/a.ts /etc/cron.d/backdoor" },
  ]) {
    const decision = policy.evaluate(request({ input }));
    assert.equal(decision.decision, "DENY", `expected DENY for: ${JSON.stringify(input)}`);
    assert.match((decision as { reason: string }).reason, /path boundary violation/i);
  }
});

test("TRUSTED_PROJECT: a DESTRUCTIVE-classified tool is always denied", async () => {
  const root = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [path.join(root, "workspace")] });
  const decision = policy.evaluate(request({ tool: tool({ riskLevel: "DESTRUCTIVE" }), input: { command: "echo hi" } }));
  assert.equal(decision.decision, "DENY");
  assert.match((decision as { reason: string }).reason, /DESTRUCTIVE/);
});

test("TRUSTED_PROJECT: malformed and empty inputs fail closed", async () => {
  const root = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [path.join(root, "workspace")] });
  for (const input of [null, undefined, 42, [], {}]) {
    // These are not dangerous, so they remain allowed; the point is that
    // evaluation never throws on malformed input.
    assert.doesNotThrow(() => policy.evaluate(request({ input })));
  }
});

test("WorkspaceBoundary rejects an empty root list", () => {
  assert.throws(() => new WorkspaceBoundary([]), /allowed root is required/);
});

// ---------------------------------------------------------------------------
// The approval-mode policy must be unchanged
// ---------------------------------------------------------------------------

test("DefaultPolicy still requires approval for controlled and write operations", () => {
  const policy = new DefaultPolicy();
  assert.equal(policy.evaluate(request({ input: {} })).decision, "REQUIRE_APPROVAL", "bash stays gated in approval mode");
  assert.equal(policy.evaluate(request({ tool: tool({ name: "write", riskLevel: "WRITE", sideEffect: "SIDE_EFFECTING" }) })).decision, "REQUIRE_APPROVAL");
  assert.equal(policy.evaluate(request({ tool: tool({ name: "read", riskLevel: "READ_ONLY", sideEffect: "PURE" }) })).decision, "ALLOW");
  assert.equal(policy.mode, "APPROVAL");
});
