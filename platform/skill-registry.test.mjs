import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverSkills, formatSkillCatalog, skillRiskLevel } from "./skill-registry.mjs";

const NL = String.fromCharCode(10);

function document(fields) {
  return "---" + NL + fields + NL + "---" + NL + "# Skill" + NL;
}

async function skillRoot() {
  return mkdtemp(path.join(os.tmpdir(), "pi-platform-skills-"));
}

async function writeSkill(root, directory, fields) {
  await mkdir(path.join(root, directory));
  await writeFile(path.join(root, directory, "SKILL.md"), document(fields));
}

test("discovers valid skills and ignores directories without SKILL.md", async () => {
  const root = await skillRoot();
  await writeSkill(root, "file-analysis", "name: file-analysis" + NL + "description: Analyze local files.");
  await mkdir(path.join(root, "not-a-skill"));

  const skills = await discoverSkills(root);

  assert.deepEqual(skills.map((skill) => skill.name), ["file-analysis"]);

  const catalog = formatSkillCatalog(skills);
  assert.ok(catalog.includes("file-analysis v0.0.0 [READ_ONLY]"), catalog);
  assert.ok(catalog.includes("Analyze local files"), catalog);
  assert.equal(skills[0].requiredTools.length, 0);
  assert.equal(skills[0].capabilities.length, 0);
  assert.equal(skills[0].riskLevel, "READ_ONLY");
});

test("rejects incomplete skill metadata", async () => {
  const root = await skillRoot();
  await writeSkill(root, "broken", "");
  await writeFile(path.join(root, "broken", "SKILL.md"), "# Missing frontmatter" + NL);

  await assert.rejects(
    () => discoverSkills(root, { strict: true }),
    (error) => error.message.includes("missing YAML frontmatter"),
  );
});

test("carries declared metadata through to the descriptor", async () => {
  const root = await skillRoot();
  await writeSkill(root, "report-writer", [
    "name: report-writer",
    "version: 1.4.2",
    "description: Turn findings into a report.",
    "capabilities:",
    "  - report-authoring",
    "  - evidence-synthesis",
    "supportedInputs:",
    "  - text/plain",
    "  - application/json",
    "supportedOutputs:",
    "  - text/markdown",
    "requiredTools:",
    "  - read",
    "optionalTools:",
    "  - grep",
    "constraints:",
    "  - bounded input size",
    "examples:",
    "  - summarise a log file",
    "riskLevel: READ_ONLY",
  ].join(NL));

  const [skill] = await discoverSkills(root, { knownTools: ["read", "grep", "write"] });

  assert.equal(skill.name, "report-writer");
  assert.equal(skill.version, "1.4.2");
  assert.deepEqual(skill.capabilities, ["report-authoring", "evidence-synthesis"]);
  assert.deepEqual(skill.supportedInputs, ["text/plain", "application/json"]);
  assert.deepEqual(skill.supportedOutputs, ["text/markdown"]);
  assert.deepEqual(skill.requiredTools, ["read"]);
  assert.deepEqual(skill.optionalTools, ["grep"]);
  assert.deepEqual(skill.constraints, ["bounded input size"]);
  assert.deepEqual(skill.examples, ["summarise a log file"]);
  assert.equal(skill.riskLevel, "READ_ONLY");
});

test("rejects a skill that names a tool the runtime does not have", async () => {
  const root = await skillRoot();
  await writeSkill(root, "needs-tool", [
    "name: needs-tool",
    "description: Requires a tool that does not exist.",
    "requiredTools:",
    "  - definitely_not_a_tool",
  ].join(NL));

  await assert.rejects(
    () => discoverSkills(root, { knownTools: ["read", "bash"], strict: true }),
    (error) => error.message.includes("unknown tool"),
  );
});

test("rejects a skill whose name does not match its directory", async () => {
  const root = await skillRoot();
  await writeSkill(root, "directory-name", [
    "name: different-name",
    "description: Mismatched name.",
  ].join(NL));

  await assert.rejects(
    () => discoverSkills(root, { strict: true }),
    (error) => error.message.includes("must match its directory"),
  );
});

test("risk defaults to read when the frontmatter declares no risk", async () => {
  const root = await skillRoot();
  await writeSkill(root, "read-skill", [
    "name: read-skill",
    "description: Reads things.",
  ].join(NL));

  const [skill] = await discoverSkills(root);

  assert.equal(skillRiskLevel(skill), "READ_ONLY");
  assert.ok(formatSkillCatalog([skill]).includes("read-skill v0.0.0 [READ_ONLY]"));
});

test("an explicit risk is carried through to the descriptor and the catalog", async () => {
  const root = await skillRoot();
  await writeSkill(root, "report-writer", [
    "name: report-writer",
    "description: Persist findings as a report.",
    "requiredTools:",
    "  - write",
    "risk: write",
  ].join(NL));

  const [skill] = await discoverSkills(root, { knownTools: ["write"] });

  assert.equal(skillRiskLevel(skill), "WRITE");
  assert.ok(formatSkillCatalog([skill]).includes("report-writer v0.0.0 [WRITE]"));
});

test("the lowercase risk field accepts every documented level", async () => {
  const root = await skillRoot();
  for (const [directory, declared, expected] of [
    ["a-read", "read", "READ_ONLY"],
    ["b-controlled", "controlled", "CONTROLLED"],
    ["c-write", "write", "WRITE"],
  ]) {
    await writeSkill(root, directory, [
      "name: " + directory,
      "description: Declares risk " + declared + ".",
      "risk: " + declared,
    ].join(NL));
  }

  const byName = new Map((await discoverSkills(root)).map((skill) => [skill.name, skillRiskLevel(skill)]));

  assert.equal(byName.get("a-read"), "READ_ONLY");
  assert.equal(byName.get("b-controlled"), "CONTROLLED");
  assert.equal(byName.get("c-write"), "WRITE");
});

test("risk and riskLevel are the same field and cannot both be declared", async () => {
  const root = await skillRoot();
  await writeSkill(root, "both", [
    "name: both",
    "description: Declares risk twice.",
    "risk: read",
    "riskLevel: WRITE",
  ].join(NL));

  await assert.rejects(
    () => discoverSkills(root, { strict: true }),
    (error) => error.message.includes("not both"),
  );
});

test("an invalid risk fails validation with an actionable message", async () => {
  for (const declared of ["WRITE_ONLY", "write-only", "destructive", ""]) {
    const root = await skillRoot();
    await writeSkill(root, "bad-risk", [
      "name: bad-risk",
      "description: Declares an unknown risk.",
      "risk: " + declared,
    ].join(NL));

    await assert.rejects(
      () => discoverSkills(root, { strict: true }),
      (error) => error.message.includes("risk must be one of read, controlled, write")
        && error.message.includes("SKILL.md"),
      `risk '${declared}' must be rejected with the valid values listed`,
    );
  }
});

test("discoverSkills in non-strict mode skips unknown optional tools and drops invalid required skills without throwing", async () => {
  const root = await skillRoot();
  await writeSkill(root, "valid-skill", [
    "name: valid-skill",
    "description: Valid skill.",
    "requiredTools:",
    "  - read",
  ].join(NL));
  await writeSkill(root, "optional-unknown", [
    "name: optional-unknown",
    "description: Has an unknown optional tool.",
    "optionalTools:",
    "  - nonexistent_opt",
  ].join(NL));
  await writeSkill(root, "required-unknown", [
    "name: required-unknown",
    "description: Has an unknown required tool.",
    "requiredTools:",
    "  - nonexistent_req",
  ].join(NL));

  const skills = await discoverSkills(root, { knownTools: ["read"] });
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("valid-skill"));
  assert.ok(names.includes("optional-unknown"));
  assert.equal(names.includes("required-unknown"), false);

  const optSkill = skills.find((s) => s.name === "optional-unknown");
  assert.equal(optSkill.optionalTools.length, 0);
});
