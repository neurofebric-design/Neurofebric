import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverSkills, formatSkillCatalog, DEFAULT_SKILL_FILE } from "./skill-registry.mjs";

const NL = String.fromCharCode(10);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_SKILLS = path.join(REPO_ROOT, "skills");

/**
 * The 10 sections docs/SKILL_SPEC.md requires, with the headings accepted for
 * each. Every message names the offending file and the missing piece so an
 * operator can fix it without reading the spec.
 */
const REQUIRED_SECTIONS = [
  { key: "Purpose", headings: ["Purpose"] },
  { key: "Capabilities", headings: ["Capabilities"] },
  { key: "When to Use", headings: ["When to Use", "When to use"] },
  { key: "When Not to Use", headings: ["When Not to Use", "When Not to use", "When not to use"] },
  { key: "Required Tools", headings: ["Required Tools", "Required tools"] },
  { key: "Inputs", headings: ["Inputs"] },
  { key: "Outputs", headings: ["Outputs"] },
  { key: "Workflow", headings: ["Workflow"] },
  { key: "Constraints", headings: ["Constraints"] },
  { key: "Examples", headings: ["Examples", "Example"] },
];

const RE_KEBAB = new RegExp("^[a-z0-9]+(?:-[a-z0-9]+)*$");

/** ATX headings (`## X`) of the body below the frontmatter block. */
function bodyHeadings(content, filePath) {
  const lines = content.split(NL);
  if (lines[0].trim() !== "---") {
    throw new Error(`${filePath}: missing YAML frontmatter (must start with a '---' line)`);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new Error(`${filePath}: unterminated YAML frontmatter (no closing '---')`);
  }
  return lines
    .slice(end + 1)
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

function missingSections(headings) {
  const present = headings.map((heading) => heading.toLowerCase());
  return REQUIRED_SECTIONS
    .filter((section) => !section.headings.some((heading) => present.includes(heading.toLowerCase())))
    .map((section) => section.key);
}

function readField(content, key, filePath) {
  const match = new RegExp("^" + key + ":[ ]*(.*)$", "m").exec(content.split("---")[1] ?? "");
  if (!match) throw new Error(`${filePath}: frontmatter is missing required field '${key}'`);
  return match[1].trim();
}

/**
 * Full catalog conformance for one skill directory: valid frontmatter, a
 * kebab-case name matching the directory, a description, all 10 spec sections,
 * and an examples/ fixture. Throws an actionable error on the first failure.
 */
async function assertSkillConforms(skillsRoot, directory, options = {}) {
  const skillFile = path.join(skillsRoot, directory, DEFAULT_SKILL_FILE);
  const content = await readFile(skillFile, "utf8");

  const name = readField(content, "name", skillFile);
  if (!RE_KEBAB.test(name)) {
    throw new Error(`${skillFile}: frontmatter name '${name}' is not lowercase kebab-case`);
  }
  if (name !== directory) {
    throw new Error(`${skillFile}: frontmatter name '${name}' does not match its directory '${directory}'`);
  }
  const description = readField(content, "description", skillFile);
  if (description === "") {
    throw new Error(`${skillFile}: frontmatter description is present but empty`);
  }

  const missing = missingSections(bodyHeadings(content, skillFile));
  if (missing.length > 0) {
    throw new Error(
      `${skillFile}: missing required section(s) from docs/SKILL_SPEC.md: ${missing.join(", ")}`,
    );
  }

  if (options.requireExamplesFixture !== false) {
    let fixtures = [];
    try {
      fixtures = await readdir(path.join(skillsRoot, directory, "examples"));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(
          `${path.join(skillsRoot, directory, "examples")}: missing examples/ directory; `
            + "every skill needs at least one example fixture (see docs/SKILL_SPEC.md 'Adding a Skill')",
        );
      }
      throw error;
    }
    if (fixtures.length === 0) {
      throw new Error(
        `${path.join(skillsRoot, directory, "examples")}: examples/ directory is empty; `
          + "add a minimal example fixture",
      );
    }
  }

  return { name, description };
}

async function projectSkillDirectories() {
  const entries = await readdir(PROJECT_SKILLS, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(PROJECT_SKILLS, entry.name, DEFAULT_SKILL_FILE), "utf8");
      directories.push(entry.name);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return directories.sort();
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "pi-skill-conformance-"));
}

async function writeBrokenSkill(root, directory, body) {
  await mkdir(path.join(root, directory, "examples"), { recursive: true });
  await writeFile(path.join(root, directory, "examples", "sample.txt"), "fixture" + NL);
  await writeFile(path.join(root, directory, DEFAULT_SKILL_FILE), body);
}

const FULL_BODY = [
  "## Purpose", "p", "## Capabilities", "c", "## When to Use", "u", "## When Not to Use", "n",
  "## Required Tools", "t", "## Inputs", "i", "## Outputs", "o", "## Workflow", "w",
  "## Constraints", "k", "## Example", "e",
].join(NL + NL);

test("the project skill catalog satisfies docs/SKILL_SPEC.md", async () => {
  const directories = await projectSkillDirectories();
  assert.ok(directories.length > 0, "no skills discovered under skills/");

  for (const directory of directories) {
    const { name, description } = await assertSkillConforms(PROJECT_SKILLS, directory);
    assert.equal(name, directory);
    assert.ok(description.length > 0);
  }

  // The registry must accept the same catalog it just validated structurally.
  const skills = await discoverSkills(PROJECT_SKILLS);
  assert.deepEqual(skills.map((skill) => skill.name), directories);
  assert.ok(formatSkillCatalog(skills).includes("file-analysis"));
  assert.ok(formatSkillCatalog(skills).includes("log-analysis"));
});

test("file-analysis and log-analysis both conform", async () => {
  const directories = await projectSkillDirectories();
  assert.ok(directories.includes("file-analysis"), "skills/file-analysis is missing");
  assert.ok(directories.includes("log-analysis"), "skills/log-analysis is missing");

  for (const directory of ["file-analysis", "log-analysis"]) {
    const result = await assertSkillConforms(PROJECT_SKILLS, directory);
    assert.equal(result.name, directory);
  }
});

test("a conforming skill is accepted", async () => {
  const root = await tempRoot();
  await writeBrokenSkill(
    root,
    "good-skill",
    "---" + NL + "name: good-skill" + NL + "description: Do a thing. Use when a user asks for it." + NL + "---" + NL + FULL_BODY,
  );
  const result = await assertSkillConforms(root, "good-skill");
  assert.equal(result.name, "good-skill");
});

test("a non-kebab-case name is rejected with the file and the bad value", async () => {
  const root = await tempRoot();
  await writeBrokenSkill(
    root,
    "good-skill",
    "---" + NL + "name: Good_Skill" + NL + "description: Do a thing." + NL + "---" + NL + FULL_BODY,
  );
  await assert.rejects(
    () => assertSkillConforms(root, "good-skill"),
    (error) => error.message.includes("Good_Skill") && error.message.includes("kebab-case")
      && error.message.includes("SKILL.md"),
  );
});

test("a name that does not match its directory is rejected", async () => {
  const root = await tempRoot();
  await writeBrokenSkill(
    root,
    "other-dir",
    "---" + NL + "name: good-skill" + NL + "description: Do a thing." + NL + "---" + NL + FULL_BODY,
  );
  await assert.rejects(
    () => assertSkillConforms(root, "other-dir"),
    (error) => error.message.includes("does not match its directory 'other-dir'"),
  );
});

test("a missing description is rejected", async () => {
  const root = await tempRoot();
  await writeBrokenSkill(root, "no-desc", "---" + NL + "name: no-desc" + NL + "---" + NL + FULL_BODY);
  await assert.rejects(
    () => assertSkillConforms(root, "no-desc"),
    (error) => error.message.includes("description"),
  );
});

test("missing required sections are all named at once", async () => {
  const root = await tempRoot();
  await writeBrokenSkill(
    root,
    "thin-skill",
    "---" + NL + "name: thin-skill" + NL + "description: Do a thing." + NL + "---" + NL
      + "## Purpose" + NL + NL + "p" + NL + NL + "## Example" + NL + NL + "e" + NL,
  );
  await assert.rejects(
    () => assertSkillConforms(root, "thin-skill"),
    (error) => error.message.includes("Capabilities")
      && error.message.includes("When to Use")
      && error.message.includes("Constraints")
      && error.message.includes("SKILL.md"),
  );
});

test("a skill without an examples fixture is rejected", async () => {
  const root = await tempRoot();
  await mkdir(path.join(root, "no-examples"));
  await writeFile(
    path.join(root, "no-examples", DEFAULT_SKILL_FILE),
    "---" + NL + "name: no-examples" + NL + "description: Do a thing." + NL + "---" + NL + FULL_BODY,
  );
  await assert.rejects(
    () => assertSkillConforms(root, "no-examples"),
    (error) => error.message.includes("examples") && error.message.includes("no-examples"),
  );
});

test("registry discovery rejects a skill that is not structurally conforming", async () => {
  const root = await tempRoot();
  await writeBrokenSkill(root, "Bad-Name", "---" + NL + "name: Bad-Name" + NL + "description: x" + NL + "---" + NL);
  await assert.rejects(
    () => discoverSkills(root, { strict: true }),
    (error) => error.message.includes("kebab-case"),
  );
});
