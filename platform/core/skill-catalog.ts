import type { RiskLevel, SkillDescriptor } from "./types.ts";

export interface SkillMetadataInput {
  name: string;
  version?: string;
  description: string;
  capabilities?: string[];
  supportedInputs?: string[];
  supportedOutputs?: string[];
  requiredTools?: string[];
  optionalTools?: string[];
  dependencies?: string[];
  constraints?: string[];
  riskLevel?: RiskLevel;
  examples?: string[];
}

export function toSkillDescriptor(input: SkillMetadataInput, fallbackRisk: RiskLevel = "READ_ONLY"): SkillDescriptor {
  return {
    name: input.name,
    version: input.version ?? "0.0.0",
    description: input.description,
    capabilities: input.capabilities ?? [],
    supportedInputs: input.supportedInputs ?? [],
    supportedOutputs: input.supportedOutputs ?? [],
    requiredTools: input.requiredTools ?? [],
    optionalTools: input.optionalTools ?? [],
    dependencies: input.dependencies ?? [],
    constraints: input.constraints ?? [],
    riskLevel: input.riskLevel ?? fallbackRisk,
    examples: input.examples ?? [],
  };
}

export function skillsForCapabilities(skills: SkillDescriptor[], capabilities: string[]): SkillDescriptor[] {
  const required = new Set(capabilities);
  return skills.filter((skill) => [...required].every((capability) => skill.capabilities.includes(capability)));
}
