import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseFrontmatter(content, filePath) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`${filePath}: missing YAML frontmatter`);
  }

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) fields.set(key, value);
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !SKILL_NAME.test(name)) {
    throw new Error(`${filePath}: name must be lowercase kebab-case`);
  }
  if (!description) {
    throw new Error(`${filePath}: description is required`);
  }

  return { name, description, path: filePath };
}

export async function discoverSkills(skillsRoot) {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    try {
      const content = await readFile(skillFile, "utf8");
      const skill = parseFrontmatter(content, skillFile);
      if (skill.name !== entry.name) {
        throw new Error(`${skillFile}: name must match directory '${entry.name}'`);
      }
      skills.push(skill);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export function formatSkillCatalog(skills) {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}
