import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertResolvableDependencies,
  assertUniqueSkills,
  parseSkillDocument,
} from "./core/skill-metadata.ts";

export const DEFAULT_SKILL_FILE = "SKILL.md";

const NL = String.fromCharCode(10);

export async function discoverSkills(skillsRoot, options = {}) {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsRoot, entry.name, DEFAULT_SKILL_FILE);
    try {
      const content = await readFile(skillFile, "utf8");
      skills.push(parseSkillDocument(content, {
        filePath: skillFile,
        directoryName: entry.name,
        knownTools: options.knownTools,
      }));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));
  assertUniqueSkills(skills);
  assertResolvableDependencies(skills);
  return skills;
}

export function formatSkillCatalog(skills) {
  return skills
    .map((skill) => {
      const capabilities = skill.capabilities.length > 0 ? skill.capabilities.join(", ") : "none declared";
      const tools = skill.requiredTools.length > 0 ? skill.requiredTools.join(", ") : "none required";
      return "- " + skill.name + " v" + skill.version + " [" + skill.riskLevel + "]"
        + " capabilities: " + capabilities
        + " requiredTools: " + tools
        + ": " + skill.description;
    })
    .join(NL);
}
