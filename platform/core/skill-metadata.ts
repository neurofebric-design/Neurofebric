import { toSkillDescriptor, type SkillMetadataInput } from "./skill-catalog.ts";
import type { RiskLevel, SkillDescriptor } from "./types.ts";

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const SLASH = String.fromCharCode(47);
const BACKSLASH = String.fromCharCode(92);

const RE_NAME = new RegExp("^[a-z0-9]+(?:-[a-z0-9]+)*$");
const RE_CAPABILITY = new RegExp("^[a-z0-9]+(?:[._-][a-z0-9]+)*$");
const RE_TOOL = new RegExp("^[a-z][a-z0-9_]*$");
const RE_DRIVE = new RegExp("^[a-zA-Z]:");
const RE_VERSION = new RegExp("^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$");
const RE_TYPE = new RegExp("^[a-z0-9][a-z0-9.+-]*(?:" + SLASH + "[a-z0-9][a-z0-9.+-]*)?$");
const RE_PAIR = new RegExp("^([A-Za-z0-9_.-]+):(?:[ ]+(.*))?$");
const RE_ITEM = new RegExp("^[ ]*-[ ]+(.*)$");

export class SkillMetadataError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "SkillMetadataError";
    this.field = field;
  }
}

export const ALLOWED_FRONTMATTER_KEYS = [
  "name",
  "version",
  "description",
  "capabilities",
  "supportedInputs",
  "supportedOutputs",
  "requiredTools",
  "optionalTools",
  "dependencies",
  "constraints",
  "riskLevel",
  "risk",
  "examples",
] as const;

export type FrontmatterKey = (typeof ALLOWED_FRONTMATTER_KEYS)[number];

const LIST_KEYS: ReadonlySet<string> = new Set([
  "capabilities",
  "supportedInputs",
  "supportedOutputs",
  "requiredTools",
  "optionalTools",
  "dependencies",
  "constraints",
  "examples",
]);

const SCALAR_KEYS: ReadonlySet<string> = new Set(["name", "version", "description", "riskLevel", "risk"]);

const KNOWN_RISK_LEVELS: ReadonlySet<string> = new Set<RiskLevel>([
  "READ_ONLY",
  "CONTROLLED",
  "WRITE",
  "DESTRUCTIVE",
]);

const ALLOWED_SKILL_RISK: ReadonlySet<string> = new Set<RiskLevel>(["READ_ONLY", "CONTROLLED", "WRITE"]);

/**
 * The lowercase spelling authors write, mapped onto the kernel's canonical
 * `RiskLevel`. `risk` and `riskLevel` are two spellings of ONE field, so they
 * are mutually exclusive rather than independently meaningful.
 */
export const SKILL_RISK_BY_NAME: Readonly<Record<string, RiskLevel>> = {
  read: "READ_ONLY",
  controlled: "CONTROLLED",
  write: "WRITE",
};

export const SKILL_RISK_NAMES: readonly string[] = Object.keys(SKILL_RISK_BY_NAME);

const MAX_DESCRIPTION = 2000;
const MAX_ITEM_LENGTH = 200;
const MAX_ITEMS = 50;
const MAX_ITEMS_TOTAL = 400;

export interface SkillValidationContext {
  filePath: string;
  directoryName?: string;
  knownTools?: readonly string[];
}

export type FrontmatterValue = string | string[];
export type FrontmatterFields = Record<string, FrontmatterValue>;

function normalizeLine(line: string): string {
  return line.endsWith(CR) ? line.slice(0, line.length - 1) : line;
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function hasTabIndent(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === " ") continue;
    return char === TAB;
  }
  return false;
}

function splitFrontmatter(content: string, filePath: string): string[] {
  const lines = content.split(NL);
  if (lines.length === 0 || normalizeLine(lines[0]).trim() !== "---") {
    throw new SkillMetadataError(filePath + ": missing YAML frontmatter", "frontmatter");
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (normalizeLine(lines[index]).trim() === "---") {
      return lines.slice(1, index).map(normalizeLine);
    }
  }
  throw new SkillMetadataError(filePath + ": unterminated YAML frontmatter", "frontmatter");
}

function stripComment(raw: string, filePath: string, key: string): string {
  let quote = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || raw[index - 1] === " " || raw[index - 1] === TAB)) {
      return raw.slice(0, index).trimEnd();
    }
  }
  if (quote !== "") {
    throw new SkillMetadataError(filePath + ": unterminated quoted value for " + key, key);
  }
  return raw.trimEnd();
}

function unquote(value: string, filePath: string, key: string): string {
  if (value.length === 0) return value;
  const first = value[0];
  if (first === '"' || first === "'") {
    if (value.length < 2 || value[value.length - 1] !== first) {
      throw new SkillMetadataError(filePath + ": unterminated quoted value for " + key, key);
    }
    return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatterFields(content: string, filePath: string): FrontmatterFields {
  const body = splitFrontmatter(content, filePath);
  const fields: FrontmatterFields = {};
  let currentKey: string | undefined;

  for (const line of body) {
    if (line.trim() === "") continue;
    if (hasTabIndent(line)) {
      throw new SkillMetadataError(filePath + ": tab indentation is not supported", currentKey);
    }

    const item = RE_ITEM.exec(line);
    if (item) {
      if (currentKey === undefined) {
        throw new SkillMetadataError(filePath + ": list item before any key");
      }
      if (!LIST_KEYS.has(currentKey)) {
        throw new SkillMetadataError(filePath + ": " + currentKey + " does not accept a list", currentKey);
      }
      const existing = fields[currentKey];
      const list = Array.isArray(existing) ? existing.slice() : [];
      if (list.length >= MAX_ITEMS) {
        throw new SkillMetadataError(filePath + ": " + currentKey + " exceeds " + MAX_ITEMS + " entries", currentKey);
      }
      list.push(unquote(stripComment(item[1], filePath, currentKey), filePath, currentKey));
      fields[currentKey] = list;
      continue;
    }

    const pair = RE_PAIR.exec(line);
    if (!pair) {
      throw new SkillMetadataError(filePath + ": unsupported YAML line: " + JSON.stringify(line), currentKey);
    }

    const key = pair[1];
    const inline = pair[2] === undefined ? "" : pair[2];

    if (fields[key] !== undefined) {
      throw new SkillMetadataError(filePath + ": duplicate key " + key, key);
    }
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key as FrontmatterKey)) {
      throw new SkillMetadataError(filePath + ": unknown frontmatter key " + key, key);
    }

    const first = inline.length === 0 ? "" : inline[0];
    if (first === "&" || first === "*" || first === "!" || first === "|" || first === ">"
      || first === "%" || first === "{" || first === "[") {
      throw new SkillMetadataError(
        filePath + ": unsupported YAML construct for " + key
          + ": anchors, aliases, tags, block scalars, directives and flow collections are not allowed",
        key,
      );
    }

    if (inline.trim() === "") {
      fields[key] = LIST_KEYS.has(key) ? [] : "";
      currentKey = key;
      continue;
    }

    if (LIST_KEYS.has(key)) {
      throw new SkillMetadataError(filePath + ": " + key + " must be a list, not a scalar", key);
    }
    fields[key] = unquote(stripComment(inline, filePath, key), filePath, key);
    currentKey = key;
  }

  return fields;
}

function asString(value: FrontmatterValue | undefined, field: string, filePath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SkillMetadataError(filePath + ": " + field + " must be a single value, not a list", field);
  }
  return value;
}

function asList(value: FrontmatterValue | undefined, field: string, filePath: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SkillMetadataError(filePath + ": " + field + " must be a list", field);
  }
  return value;
}

function assertPlainText(value: string, field: string, filePath: string, maxLength = MAX_ITEM_LENGTH): string {
  if (hasControlChars(value)) {
    throw new SkillMetadataError(filePath + ": " + field + " contains control characters", field);
  }
  if (value.length > maxLength) {
    throw new SkillMetadataError(filePath + ": " + field + " exceeds " + maxLength + " characters", field);
  }
  return value;
}

function assertNotAPath(value: string, field: string, filePath: string): string {
  assertPlainText(value, field, filePath);
  if (value.includes(BACKSLASH) || value.startsWith(SLASH) || value.startsWith("~")) {
    throw new SkillMetadataError(filePath + ": " + field + " must be a type, not a path", field);
  }
  if (value.includes("..")) {
    throw new SkillMetadataError(filePath + ": " + field + " must not reference a parent directory", field);
  }
  if (RE_DRIVE.test(value)) {
    throw new SkillMetadataError(filePath + ": " + field + " must not contain a drive letter", field);
  }
  if (!RE_TYPE.test(value)) {
    throw new SkillMetadataError(filePath + ": " + field + " entry " + value + " is not a valid type token", field);
  }
  return value;
}

function rejectDuplicates(values: string[], field: string, filePath: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new SkillMetadataError(filePath + ": duplicate entry " + value + " in " + field, field);
    }
    seen.add(value);
  }
  return values;
}

export function validateSkillMetadata(fields: FrontmatterFields, context: SkillValidationContext): SkillMetadataInput {
  const filePath = context.filePath;

  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key as FrontmatterKey)) {
      throw new SkillMetadataError(filePath + ": unknown frontmatter key " + key, key);
    }
  }

  const name = asString(fields.name, "name", filePath);
  if (name === undefined || name.trim() === "") {
    throw new SkillMetadataError(filePath + ": name is required and must not be empty", "name");
  }
  if (!RE_NAME.test(name)) {
    throw new SkillMetadataError(filePath + ": name must be lowercase kebab-case", "name");
  }
  if (context.directoryName !== undefined && name !== context.directoryName) {
    throw new SkillMetadataError(filePath + ": name must match its directory " + context.directoryName, "name");
  }

  const description = asString(fields.description, "description", filePath);
  if (description === undefined || description.trim() === "") {
    throw new SkillMetadataError(filePath + ": description is required and must not be empty", "description");
  }
  assertPlainText(description, "description", filePath, MAX_DESCRIPTION);

  const version = asString(fields.version, "version", filePath);
  if (version !== undefined && !RE_VERSION.test(version)) {
    throw new SkillMetadataError(filePath + ": version must be semantic, for example 1.2.3", "version");
  }

  const declaredRiskLevel = asString(fields.riskLevel, "riskLevel", filePath);
  if (declaredRiskLevel !== undefined) {
    if (!KNOWN_RISK_LEVELS.has(declaredRiskLevel)) {
      throw new SkillMetadataError(
        filePath + ": riskLevel must be one of READ_ONLY, CONTROLLED, WRITE, DESTRUCTIVE",
        "riskLevel",
      );
    }
    if (!ALLOWED_SKILL_RISK.has(declaredRiskLevel)) {
      throw new SkillMetadataError(filePath + ": a skill may not declare riskLevel DESTRUCTIVE", "riskLevel");
    }
  }

  // `risk: read | controlled | write` is the same classification in the
  // lowercase spelling used by docs/SKILL_SPEC.md. It normalises onto
  // `riskLevel` so the kernel and the catalog only ever see one representation.
  const declaredRisk = asString(fields.risk, "risk", filePath);
  if (declaredRisk !== undefined && declaredRiskLevel !== undefined) {
    throw new SkillMetadataError(
      filePath + ": declare either 'risk' or 'riskLevel', not both; they are the same field",
      "risk",
    );
  }
  let riskLevel = declaredRiskLevel as RiskLevel | undefined;
  if (declaredRisk !== undefined) {
    const mapped = SKILL_RISK_BY_NAME[declaredRisk];
    if (mapped === undefined) {
      throw new SkillMetadataError(
        filePath + ": risk must be one of " + SKILL_RISK_NAMES.join(", ") + "; got '" + declaredRisk + "'",
        "risk",
      );
    }
    riskLevel = mapped;
  }

  const capabilities = rejectDuplicates(
    asList(fields.capabilities, "capabilities", filePath).map((value) => {
      assertPlainText(value, "capabilities", filePath);
      if (!RE_CAPABILITY.test(value)) {
        throw new SkillMetadataError(filePath + ": capability " + value + " is not a valid identifier", "capabilities");
      }
      return value;
    }),
    "capabilities",
    filePath,
  );

  const supportedInputs = rejectDuplicates(
    asList(fields.supportedInputs, "supportedInputs", filePath)
      .map((value) => assertNotAPath(value, "supportedInputs", filePath)),
    "supportedInputs",
    filePath,
  );

  const supportedOutputs = rejectDuplicates(
    asList(fields.supportedOutputs, "supportedOutputs", filePath)
      .map((value) => assertNotAPath(value, "supportedOutputs", filePath)),
    "supportedOutputs",
    filePath,
  );

  const knownTools = new Set<string>(context.knownTools === undefined ? [] : context.knownTools);
  const checkTool = (value: string, field: string, optional: boolean): string | undefined => {
    assertPlainText(value, field, filePath);
    if (!RE_TOOL.test(value)) {
      throw new SkillMetadataError(filePath + ": tool name " + value + " is not valid", field);
    }
    if (knownTools.size > 0 && !knownTools.has(value)) {
      if (optional) {
        console.warn(filePath + ": " + field + " names unknown tool " + value + ", skipping");
        return undefined;
      }
      throw new SkillMetadataError(filePath + ": " + field + " names unknown tool " + value, field);
    }
    return value;
  };

  const requiredTools = rejectDuplicates(
    asList(fields.requiredTools, "requiredTools", filePath)
      .map((value) => checkTool(value, "requiredTools", false)!)
      .filter((v): v is string => v !== undefined),
    "requiredTools",
    filePath,
  );
  const optionalTools = rejectDuplicates(
    asList(fields.optionalTools, "optionalTools", filePath)
      .map((value) => checkTool(value, "optionalTools", true))
      .filter((v): v is string => v !== undefined),
    "optionalTools",
    filePath,
  );
  for (const tool of requiredTools) {
    if (optionalTools.includes(tool)) {
      throw new SkillMetadataError(filePath + ": tool " + tool + " cannot be both required and optional", "optionalTools");
    }
  }

  const dependencies = rejectDuplicates(
    asList(fields.dependencies, "dependencies", filePath).map((value) => {
      assertPlainText(value, "dependencies", filePath);
      if (!RE_NAME.test(value)) {
        throw new SkillMetadataError(filePath + ": dependency " + value + " is not a valid skill name", "dependencies");
      }
      if (value === name) {
        throw new SkillMetadataError(filePath + ": a skill may not depend on itself", "dependencies");
      }
      return value;
    }),
    "dependencies",
    filePath,
  );

  const constraints = rejectDuplicates(
    asList(fields.constraints, "constraints", filePath)
      .map((value) => assertPlainText(value, "constraints", filePath)),
    "constraints",
    filePath,
  );

  const examples = rejectDuplicates(
    asList(fields.examples, "examples", filePath)
      .map((value) => assertPlainText(value, "examples", filePath, 500)),
    "examples",
    filePath,
  );

  const total = capabilities.length + supportedInputs.length + supportedOutputs.length
    + requiredTools.length + optionalTools.length + dependencies.length
    + constraints.length + examples.length;
  if (total > MAX_ITEMS_TOTAL) {
    throw new SkillMetadataError(filePath + ": frontmatter declares too many entries", "frontmatter");
  }

  return {
    name,
    version,
    description,
    capabilities,
    supportedInputs,
    supportedOutputs,
    requiredTools,
    optionalTools,
    dependencies,
    constraints,
    riskLevel,
    examples,
  };
}

export function parseSkillDocument(content: string, context: SkillValidationContext): SkillDescriptor {
  const fields = parseFrontmatterFields(content, context.filePath);
  return toSkillDescriptor(validateSkillMetadata(fields, context), "READ_ONLY");
}

export function assertUniqueSkills(skills: readonly SkillDescriptor[]): void {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new SkillMetadataError("duplicate skill name " + skill.name + " in catalog", "name");
    }
    seen.add(skill.name);
  }
}

export function assertResolvableDependencies(skills: readonly SkillDescriptor[]): void {
  const names = new Set<string>(skills.map((skill) => skill.name));
  for (const skill of skills) {
    for (const dependency of skill.dependencies) {
      if (!names.has(dependency)) {
        throw new SkillMetadataError(
          "skill " + skill.name + " depends on unknown skill " + dependency,
          "dependencies",
        );
      }
    }
  }
}
