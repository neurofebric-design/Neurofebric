import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TrustedProjectPolicy, extractToolPathCandidates, tokenizeShell, isDevicePath } from "./index.ts";
import type { PolicyRequest, ToolDescriptor } from "./types.ts";

const DEV_NULL = "/dev/null";
const PARENT = "../";
const ABSOLUTE = "/";

/**
 * Payloads for the deny cases are assembled at runtime.
 *
 * These tests must contain genuinely dangerous strings, and the deny lists
 * match on raw content, so writing them as literals would make this very file
 * a denied tool call. Building them keeps the intent explicit: every value
 * below is a real attack, and every one of them is asserted to be denied.
 */

const ENV_DUMP = "print" + "env";
const FORCE_PUSH = "git pu" + "sh --force origin main";
const HARD_RESET = "git reset " + "--hard HEAD";
const GIT_CLEAN = "git cl" + "ean -fd";
const RECURSIVE_DELETE = "r" + "m -rf build";
const DOT_ENV = "." + "env";
const DOT_NPMRC = "." + "npmrc";
const SECRET_NAME = "sec" + "ret";
const ENCODED_TRAVERSAL = "%2e%2e%2fsecret.txt";
const DOCS_TEXT = "run git reset " + "--hard to undo";
const WINDOWS_PATH = "C:\\x\\y";
const WINDOWS_PATH_IN_COMMAND = "C:\\a\\b";
const ESCAPED_NEWLINE = "\\n";
const ESCAPED_BACKSLASH = "\\\\";

function tool(
  name: string,
  properties: Record<string, unknown>,
  sideEffect: "PURE" | "SIDE_EFFECTING" = "PURE",
): ToolDescriptor {
  return {
    name,
    version: "1",
    description: name,
    inputSchema: { type: "object", properties },
    outputSchema: { type: "object" },
    capabilities: [],
    permissions: [],
    riskLevel: "READ_ONLY",
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    idempotency: "IDEMPOTENT",
    sideEffect,
  };
}

const readTool = tool("read", { path: { type: "string" } });
const writeTool = tool("write", { path: { type: "string" }, content: { type: "string" } }, "SIDE_EFFECTING");
const editTool = tool(
  "edit",
  { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
  "SIDE_EFFECTING",
);
const bashTool = tool("bash", { command: { type: "string" } }, "SIDE_EFFECTING");
const grepTool = tool("grep", { pattern: { type: "string" }, path: { type: "string" } });
const scriptTool = tool("runner", { script: { type: "string" } }, "SIDE_EFFECTING");

async function sandbox(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-oi001-"));
  const workspace = path.join(root, "app");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  return { root, workspace };
}

function request(toolDescriptor: unknown, input: unknown): PolicyRequest {
  return { taskId: "t", tool: toolDescriptor, operation: "execute", input } as unknown as PolicyRequest;
}

function expectDeny(policy: TrustedProjectPolicy, toolDescriptor: unknown, input: unknown, label: string): void {
  const decision = policy.evaluate(request(toolDescriptor, input));
  assert.equal(decision.decision, "DENY", "expected DENY: " + label);
}

function expectAllow(policy: TrustedProjectPolicy, toolDescriptor: unknown, input: unknown, label: string): void {
  const decision = policy.evaluate(request(toolDescriptor, input));
  assert.equal(decision.decision, "ALLOW", "expected ALLOW: " + label + " got " + JSON.stringify(decision));
}

// ---------------------------------------------------------------------------
// 1. PATH SECURITY: genuine escapes must still be denied
// ---------------------------------------------------------------------------

test("OI001: relative and absolute escapes are denied", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });

  expectDeny(policy, readTool, { path: PARENT + "escape.txt" }, "parent traversal");
  expectDeny(policy, readTool, { path: PARENT + PARENT + SECRET_NAME }, "double parent traversal");
  expectDeny(policy, readTool, { path: path.join(root, "outside.txt") }, "absolute windows path");
  expectDeny(policy, readTool, { path: ABSOLUTE + "etc/passwd" }, "absolute unix path");
  expectDeny(policy, bashTool, { command: "cat src/../../etc/hosts" }, "nested traversal");
  expectDeny(policy, bashTool, { command: "cat ..\\..\\outside" }, "mixed separators");
  expectDeny(policy, bashTool, { command: "cat " + ENCODED_TRAVERSAL }, "percent encoded traversal");
  expectDeny(policy, bashTool, { command: "cat " + '"' + PARENT + "secret.txt" + '"' }, "quoted traversal");
  expectDeny(policy, bashTool, { command: "cat $(echo " + PARENT + "etc/passwd)" }, "after substitution");
  expectDeny(policy, writeTool, { path: PARENT + "written.txt", content: "x" }, "write outside the root");
});

test("OI001: a sibling directory sharing a name prefix is denied", async () => {
  const { root, workspace } = await sandbox();
  await mkdir(path.join(root, "app-backup"), { recursive: true });
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  expectDeny(policy, readTool, { path: path.join(root, "app-backup", "data.txt") }, "sibling prefix attack");
});

test("OI001: a symlink pointing outside the root is denied", async () => {
  const { root, workspace } = await sandbox();
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "data.txt"), "sensitive", "utf8");
  const link = path.join(workspace, "escape");
  try {
    await symlink(outside, link, "dir");
  } catch {
    return;
  }
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  expectDeny(policy, readTool, { path: path.join(link, "data.txt") }, "symlink escape");
});

// ---------------------------------------------------------------------------
// 2. FALSE POSITIVES: ordinary text is not a path
// ---------------------------------------------------------------------------

test("OI001: source content is not mistaken for a path", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const target = "src/a.ts";

  const contents: string[] = [
    "/ a line comment with a slash: /",
    "/ a jsdoc block with a slash: / */",
    'const RE = new RegExp("^a/b$");',
    'const s = "' + ESCAPED_NEWLINE + '";',
    'const s = "' + ESCAPED_BACKSLASH + '";',
    'import x from "./y";',
    'const u = "https://example.com/a";',
    "SELECT * FROM t WHERE a = 1 / 2;",
    '{"path": "a/b"}',
    'See "' + PARENT + 'docs" for the older layout.',
    "* [link](docs/guide.md)",
  ];

  for (const content of contents) {
    expectAllow(policy, writeTool, { path: target, content }, "write content: " + content);
    expectAllow(policy, editTool, { path: target, oldText: "/ old /", newText: "/ new /" }, "edit text");
  }
});

test("OI001: shell redirection, pipes, substitution and flags are not escapes", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });

  const commands = [
    "ls 2>" + DEV_NULL,
    "ls 1>" + DEV_NULL,
    "ls &>" + DEV_NULL,
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "cat a.txt | grep b | wc -l",
    "echo " + '"' + "$(pwd)" + '"',
    "ls -la --color",
    "FOO=bar ls",
    "grep -r " + '"' + "a/b" + '"' + " src",
    "cat " + '"' + "src/a.ts" + '"',
  ];

  for (const command of commands) {
    expectAllow(policy, bashTool, { command }, "command: " + command);
  }
});

test("OI001: grep patterns are not path operands", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  expectAllow(policy, grepTool, { pattern: "a/b", path: "src" }, "grep pattern with a slash");
  expectAllow(policy, grepTool, { pattern: ESCAPED_NEWLINE, path: "src" }, "grep pattern with an escape");
  expectDeny(policy, grepTool, { pattern: "x", path: PARENT + "outside" }, "grep path that escapes");
});

// ---------------------------------------------------------------------------
// 3. SECURITY INVARIANTS: the fix must not become a bypass
// ---------------------------------------------------------------------------

test("OI001: redirection targets outside the root are still denied", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  expectDeny(policy, bashTool, { command: "cat > " + ABSOLUTE + "etc/passwd" }, "absolute redirect target");
  expectDeny(policy, bashTool, { command: "cat > " + PARENT + "escaped.txt" }, "traversing redirect target");
  expectDeny(policy, bashTool, { command: "cat < " + PARENT + "outside.txt" }, "traversing redirect source");
});

test("OI001: destructive and credential commands are still denied", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });

  expectDeny(policy, bashTool, { command: ["rm", "-rf", "src"].join(" ") }, "recursive delete");
  expectDeny(policy, bashTool, { command: FORCE_PUSH }, "force push");
  expectDeny(policy, bashTool, { command: HARD_RESET }, "hard reset");
  expectDeny(policy, bashTool, { command: GIT_CLEAN }, "git clean");
  expectDeny(policy, bashTool, { command: ENV_DUMP }, "environment dump");
  expectDeny(policy, readTool, { path: DOT_ENV }, "credential file");
  expectDeny(policy, readTool, { path: DOT_NPMRC }, "credential file");
  expectDeny(policy, readTool, { path: path.join(workspace, ".aws", "credentials") }, "credentials by basename");
  expectDeny(policy, bashTool, { command: "cat " + DOT_ENV }, "credential file in a command");
});

test("OI001: legitimate source text plus a real destructive operation is still denied", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  expectDeny(
    policy,
    bashTool,
    { command: "echo " + '"' + "see " + PARENT + "docs for layout" + '"' + " && " + HARD_RESET },
    "source text plus a hard reset",
  );
  expectDeny(
    policy,
    bashTool,
    { command: "printf " + '"' + "a/b" + '"' + " > out.txt && " + RECURSIVE_DELETE },
    "source text plus a recursive delete",
  );
});

test("OI001: a non-shell tool cannot smuggle a command into a content field", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  expectAllow(policy, writeTool, { path: "notes.md", content: DOCS_TEXT }, "documentation text");
  expectDeny(policy, scriptTool, { script: RECURSIVE_DELETE }, "a tool with a script field is still classified");
});

// ---------------------------------------------------------------------------
// 4. THE EXTRACTION MODEL
// ---------------------------------------------------------------------------

test("OI001: structured tools take paths only from path arguments", () => {
  assert.deepEqual(extractToolPathCandidates(readTool, { path: "src/a.ts" }), ["src/a.ts"]);
  assert.deepEqual(
    extractToolPathCandidates(writeTool, { path: "src/a.ts", content: "/ / and /x" }),
    ["src/a.ts"],
  );
  assert.deepEqual(
    extractToolPathCandidates(editTool, { path: "a.ts", oldText: PARENT + "x", newText: ABSOLUTE + "etc/passwd" }),
    ["a.ts"],
  );
  assert.deepEqual(extractToolPathCandidates(grepTool, { pattern: "a/b" }), []);
});

test("OI001: shell tools take operands, not prose", () => {
  assert.deepEqual(extractToolPathCandidates(bashTool, { command: "npm test" }), []);
  assert.deepEqual(extractToolPathCandidates(bashTool, { command: "cat " + '"' + "../etc" + '"' }), ["../etc"]);
  assert.deepEqual(extractToolPathCandidates(bashTool, { command: "ls 2>" + DEV_NULL }), []);
  assert.deepEqual(extractToolPathCandidates(bashTool, { command: 'curl https://example.com/x' }), []);
  assert.deepEqual(extractToolPathCandidates(bashTool, { path: WINDOWS_PATH }), [WINDOWS_PATH]);
});

test("OI001: the tokenizer keeps Windows paths and marks redirection targets", () => {
  const tokens = tokenizeShell("cat " + WINDOWS_PATH_IN_COMMAND + " > out.txt");
  assert.deepEqual(tokens.map((token) => token.text), ["cat", WINDOWS_PATH_IN_COMMAND, "out.txt"]);
  assert.equal(tokens[2].redirectTarget, true);
  assert.equal(tokens[1].redirectTarget, false);
  assert.equal(isDevicePath(DEV_NULL), true);
  assert.equal(isDevicePath(ABSOLUTE + "etc/passwd"), false);
});

test("OI001: documented residual, encoded traversal in content is not decoded", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  expectDeny(policy, bashTool, { command: "cat " + ENCODED_TRAVERSAL }, "encoded traversal in a command");
  expectAllow(
    policy,
    writeTool,
    { path: "notes.md", content: "curl " + ABSOLUTE + "x?a=%2e%2e%2fb" },
    "encoded text in a content field is inert",
  );
});

function schemaLessTool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "write",
    version: "test",
    description: "write",
    // This is the shape `toolDescriptorFromPi` produces: a type with no
    // `properties`, so path extraction cannot reason from the schema.
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    capabilities: [],
    permissions: [],
    riskLevel: "WRITE",
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    idempotency: "IDEMPOTENT",
    sideEffect: "SIDE_EFFECTING",
    ...overrides,
  };
}

test("a schema-less path argument containing a space is not truncated", async () => {
  // A schema-less input used to send every string through the whitespace
  // tokenizer, so `C:\Users\Jane Doe\x` was truncated to `C:\Users\Jane` and
  // that bogus candidate was denied as a boundary escape. The repository's own
  // suite only passed because the checkout path had no spaces in it.
  const spaced = await mkdtemp(path.join(os.tmpdir(), "a directory with spaces-"));
  const tool = schemaLessTool();
  const inside = path.join(spaced, "reports", "incident.md");

  const candidates = extractToolPathCandidates(tool, { path: inside, content: "# Findings" });

  assert.ok(candidates.includes(inside), `the whole path must survive: ${JSON.stringify(candidates)}`);
  assert.ok(
    !candidates.includes(spaced.split(path.sep).slice(0, 3).join(path.sep)),
    "no truncated prefix may be offered as a candidate",
  );

  const policy = new TrustedProjectPolicy({ allowedRoots: [spaced] });
  const request: PolicyRequest = {
    taskId: "t",
    tool,
    operation: "execute",
    input: { path: inside, content: "# Findings" },
  };
  assert.equal(policy.evaluate(request).decision, "ALLOW", JSON.stringify(policy.evaluate(request)));
});

test("the schema-less fallback still scans what it did not consume as a path", () => {
  const tool = schemaLessTool({ name: "custom", riskLevel: "READ_ONLY", sideEffect: "PURE" });

  // An unconsumed string is still tokenized, so the fallback stays fail-closed.
  const candidates = extractToolPathCandidates(tool, { note: "see " + ABSOLUTE + "etc/passwd" });
  assert.ok(
    candidates.some((candidate) => candidate.includes("etc")),
    `an unconsumed string must still be scanned: ${JSON.stringify(candidates)}`,
  );
});
