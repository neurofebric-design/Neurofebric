import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverSkills, formatSkillCatalog } from "./skill-registry.mjs";

test("discovers valid skills and ignores directories without SKILL.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-platform-skills-"));
  await mkdir(path.join(root, "file-analysis"));
  await writeFile(
    path.join(root, "file-analysis", "SKILL.md"),
    "---\nname: file-analysis\ndescription: Analyze local files.\n---\n# Skill\n",
  );
  await mkdir(path.join(root, "not-a-skill"));

  const skills = await discoverSkills(root);

  assert.deepEqual(skills.map((skill) => skill.name), ["file-analysis"]);
  assert.match(formatSkillCatalog(skills), /file-analysis: Analyze local files/);
});

test("rejects incomplete skill metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-platform-skills-"));
  await mkdir(path.join(root, "broken"));
  await writeFile(path.join(root, "broken", "SKILL.md"), "# Missing frontmatter\n");

  await assert.rejects(() => discoverSkills(root), /missing YAML frontmatter/);
});
