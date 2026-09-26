import test from "node:test";
import assert from "node:assert/strict";
import {
  SkillMetadataError,
  assertResolvableDependencies,
  assertUniqueSkills,
  parseFrontmatterFields,
  parseSkillDocument,
  validateSkillMetadata,
} from "./skill-metadata.ts";
import { skillsForCapabilities, toSkillDescriptor } from "./skill-catalog.ts";
import { TrustedProjectPolicy } from "./policy.ts";
import { WorkspaceBoundary } from "./workspace.ts";
import type { PolicyRequest, SkillDescriptor } from "./types.ts";

const NL = String.fromCharCode(10);
const SLASH = String.fromCharCode(47);
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);

const CONTEXT = {
  filePath: "skills" + SLASH + "sample" + SLASH + "SKILL.md",
  directoryName: "sample",
  knownTools: ["read", "bash", "write"],
};

function doc(fields: string[]): string {
  return "---" + NL + fields.join(NL) + NL + "---" + NL + "# Sample" + NL;
}

function parse(fields: string[]): SkillDescriptor {
  return parseSkillDocument(doc(fields), CONTEXT);
}

function expectReject(fields: string[], expected: string): void {
  assert.throws(
    () => parse(fields),
    (error: unknown) => {
      assert.ok(error instanceof SkillMetadataError, "expected SkillMetadataError");
      assert.ok(error.message.includes(expected), "expected " + expected + " in: " + error.message);
      return true;
    },
  );
}

const VALID = [
  "name: sample",
  "version: 1.0.0",
  "description: A sample skill.",
];

test("accepts a complete, well formed declaration", () => {
  const skill = parse([
    ...VALID,
    "capabilities:",
    "  - alpha",
    "  - beta",
    "supportedInputs:",
    "  - text/plain",
    "supportedOutputs:",
    "  - text/markdown",
    "requiredTools:",
    "  - read",
    "optionalTools:",
    "  - write",
    "dependencies:",
    "  - other-skill",
    "constraints:",
    "  - stay within the workspace",
    "examples:",
    "  - summarise one file",
    "riskLevel: CONTROLLED",
  ]);
  assert.equal(skill.name, "sample");
  assert.equal(skill.version, "1.0.0");
  assert.deepEqual(skill.capabilities, ["alpha", "beta"]);
  assert.deepEqual(skill.requiredTools, ["read"]);
  assert.equal(skill.riskLevel, "CONTROLLED");
  assert.equal(skill.dependencies.length, 1);
});

test("defaults are the least privileged values, not invented ones", () => {
  const skill = parse(["name: sample", "description: A sample skill."]);
  assert.equal(skill.version, "0.0.0");
  assert.equal(skill.riskLevel, "READ_ONLY");
  assert.deepEqual(skill.capabilities, []);
  assert.deepEqual(skill.requiredTools, []);
  assert.deepEqual(skill.optionalTools, []);
  assert.deepEqual(skill.dependencies, []);
  assert.deepEqual(skill.constraints, []);
  assert.deepEqual(skill.examples, []);
});

test("malformed YAML is rejected", () => {
  assert.throws(() => parseFrontmatterFields("no frontmatter here", "f"), SkillMetadataError);
  assert.throws(() => parseFrontmatterFields("---" + NL + "name: x", "f"), SkillMetadataError);
  assert.throws(() => parseFrontmatterFields("---" + NL + "  indented: 1" + NL + "---" + NL, "f"), SkillMetadataError);
  assert.throws(() => parseFrontmatterFields(doc(["name: sample", "  " + TAB + "bad: 1"]), "f"), SkillMetadataError);
});

test("exotic YAML constructs are refused rather than guessed at", () => {
  expectReject(["name: sample", "description: d", "version: &anchor 1.0.0"], "unsupported YAML construct");
  expectReject(["name: sample", "description: d", "version: *anchor"], "unsupported YAML construct");
  expectReject(["name: sample", "description: d", "riskLevel: !!str READ_ONLY"], "unsupported YAML construct");
  expectReject(["name: sample", "description: d", "riskLevel: |"], "unsupported YAML construct");
  expectReject(["name: sample", "description: d", "capabilities: [a, b]"], "unsupported YAML construct");
  expectReject(["name: sample", "description: d", "capabilities: {a: 1}"], "unsupported YAML construct");
});

test("wrong field types are rejected", () => {
  expectReject(["name: sample", "description: d", "capabilities: alpha"], "must be a list, not a scalar");
  expectReject(["name: sample", "description: d", "name: other"], "duplicate key");
  expectReject(["name:", "  - sample", "description: d"], "name does not accept a list");
  expectReject(["name: sample", "description: d", "examples: one"], "must be a list, not a scalar");
});

test("empty names and empty descriptions are rejected", () => {
  expectReject(["name:", "description: d"], "name is required");
  expectReject(["name: sample", "description:"], "description is required");
  assert.throws(
    () => validateSkillMetadata({ name: "   " }, CONTEXT),
    (error: unknown) => (error as SkillMetadataError).message.includes("must not be empty"),
  );
});

test("names must be kebab-case and must match the directory", () => {
  expectReject(["name: Sample Skill", "description: d"], "lowercase kebab-case");
  expectReject(["name: sample", "description: d", "version: 1"], "version must be semantic");
  expectReject(["name: other", "description: d"], "must match its directory");
});

test("duplicate capabilities and duplicate list entries are rejected", () => {
  expectReject([...VALID, "capabilities:", "  - alpha", "  - alpha"], "duplicate entry alpha in capabilities");
  expectReject([...VALID, "requiredTools:", "  - read", "  - read"], "duplicate entry read in requiredTools");
});

test("unknown tools are rejected", () => {
  expectReject([...VALID, "requiredTools:", "  - nonexistent"], "unknown tool nonexistent");
  expectReject([...VALID, "optionalTools:", "  - nonexistent"], "unknown tool nonexistent");
  expectReject([...VALID, "requiredTools:", "  - Read"], "is not valid");
});

test("a tool cannot be both required and optional", () => {
  expectReject([...VALID, "requiredTools:", "  - read", "optionalTools:", "  - read"], "both required and optional");
});

test("invalid risk levels are rejected and destructive self declaration is refused", () => {
  expectReject([...VALID, "riskLevel: SUPER_SAFE"], "riskLevel must be one of");
  expectReject([...VALID, "riskLevel: read_only"], "riskLevel must be one of");
  expectReject([...VALID, "riskLevel: DESTRUCTIVE"], "may not declare riskLevel DESTRUCTIVE");
});

test("malformed versions are rejected", () => {
  for (const version of ["1.0", "v1.0.0", "1.0.0.0", "latest", "-1.0.0"]) {
    expectReject(["name: sample", "description: d", "version: " + version], "version must be semantic");
  }
});

test("malformed inputs and outputs are rejected", () => {
  expectReject([...VALID, "supportedInputs:", "  - TEXT/PLAIN"], "not a valid type token");
  expectReject([...VALID, "supportedOutputs:", "  - text/plain/extra/deep"], "not a valid type token");
});

test("metadata may not smuggle a filesystem path or an escape", () => {
  expectReject([...VALID, "supportedInputs:", "  - " + SLASH + "etc" + SLASH + "passwd"], "must be a type, not a path");
  expectReject([...VALID, "supportedOutputs:", "  - .." + SLASH + ".." + SLASH + "etc"], "must not reference a parent directory");
  expectReject([...VALID, "supportedInputs:", "  - ~" + SLASH + "secrets"], "must be a type, not a path");
  expectReject([...VALID, "supportedInputs:", "  - c:" + BACKSLASH + "windows"], "must be a type, not a path");
  expectReject([...VALID, "supportedOutputs:", "  - C:data"], "must not contain a drive letter");
});

test("a skill may not declare permissions or any unknown key", () => {
  for (const key of ["permissions", "allowedTools", "authorize", "policy", "sudo", "escalate"]) {
    expectReject([...VALID, key + ": true"], "unknown frontmatter key " + key);
  }
  expectReject([...VALID, "permissions:", "  - bash"], "unknown frontmatter key permissions");
});

test("risk is a descriptive tier, never a permission", () => {
  // `risk` is accepted, but only as one of three descriptive values. It is
  // normalised onto the same `riskLevel` field and grants nothing.
  for (const [declared, expected] of [
    ["read", "READ_ONLY"],
    ["controlled", "CONTROLLED"],
    ["write", "WRITE"],
  ] as const) {
    const skill = parse([...VALID, "risk: " + declared]);
    assert.equal(skill.riskLevel, expected);
  }

  // An absent declaration means read, not "unlimited".
  assert.equal(parse(VALID).riskLevel, "READ_ONLY");

  // A risk value that is not a tier is refused, and so is any attempt to use
  // the field as a switch. DESTRUCTIVE is not available to a skill.
  for (const declared of ["true", "sudo", "destructive", "WRITE", ""]) {
    expectReject([...VALID, "risk: " + declared], "risk must be one of");
  }
  expectReject([...VALID, "riskLevel: DESTRUCTIVE"], "may not declare riskLevel DESTRUCTIVE");
  expectReject([...VALID, "risk: read", "riskLevel: WRITE"], "not both");
});

test("a skill declaring bash is still only metadata", () => {
  const skill = parse([...VALID, "requiredTools:", "  - bash", "riskLevel: WRITE"]);
  assert.deepEqual(skill.requiredTools, ["bash"]);
  assert.equal(skill.riskLevel, "WRITE");
});

test("dependencies must be resolvable and never self referential", () => {
  expectReject([...VALID, "dependencies:", "  - sample"], "may not depend on itself");
  expectReject([...VALID, "dependencies:", "  - Not A Name"], "not a valid skill name");

  const orphan = toSkillDescriptor({ name: "orphan", description: "d", dependencies: ["ghost"] });
  assert.throws(
    () => assertResolvableDependencies([orphan]),
    (error: unknown) => (error as SkillMetadataError).message.includes("unknown skill ghost"),
  );
});

test("duplicate skill names in a catalog are rejected", () => {
  const one = toSkillDescriptor({ name: "twin", description: "a" });
  const two = toSkillDescriptor({ name: "twin", description: "b" });
  assert.throws(
    () => assertUniqueSkills([one, two]),
    (error: unknown) => (error as SkillMetadataError).message.includes("duplicate skill name twin"),
  );
  assert.doesNotThrow(() => assertUniqueSkills([one, toSkillDescriptor({ name: "other", description: "c" })]));
});

test("oversized declarations are rejected", () => {
  const many = ["name: sample", "description: d", "examples:"];
  for (let index = 0; index < 60; index += 1) many.push("  - example " + index);
  expectReject(many, "exceeds 50 entries");
});

test("control characters in metadata are rejected", () => {
  expectReject([...VALID, "constraints:", "  - bad" + String.fromCharCode(0) + "value"], "control characters");
});

test("capability lookup selects only skills declaring every requested capability", () => {
  const alpha = toSkillDescriptor({ name: "alpha-skill", description: "a", capabilities: ["reporting", "summarise"] });
  const beta = toSkillDescriptor({ name: "beta-skill", description: "b", capabilities: ["reporting"] });
  const gamma = toSkillDescriptor({ name: "gamma-skill", description: "c", capabilities: ["other"] });

  const catalog = [alpha, beta, gamma];

  assert.deepEqual(skillsForCapabilities(catalog, ["reporting"]).map((s) => s.name), ["alpha-skill", "beta-skill"]);
  assert.deepEqual(
    skillsForCapabilities(catalog, ["reporting", "summarise"]).map((s) => s.name),
    ["alpha-skill"],
  );
  assert.deepEqual(skillsForCapabilities(catalog, ["nonexistent"]), []);
});

test("declaring a tool in metadata does not permit it: policy stays authoritative", () => {
  const skill = parse([
    "name: sample",
    "description: Wants shell access.",
    "requiredTools:",
    "  - bash",
  ]);
  assert.deepEqual(skill.requiredTools, ["bash"]);

  const root = process.cwd();
  const policy = new TrustedProjectPolicy({ allowedRoots: [root] });

  const destructive = {
    taskId: "t1",
    operation: "execute",
    tool: { name: "bash", riskLevel: "READ_ONLY", sideEffect: "SIDE_EFFECTING" },
    input: { command: ["rm", "-rf", SLASH].join(" ") },
  } as unknown as PolicyRequest;

  assert.equal(policy.evaluate(destructive).decision, "DENY");

  const boundary = new WorkspaceBoundary([root]);
  assert.equal(boundary.checkInput(skill).allowed, true);
});
