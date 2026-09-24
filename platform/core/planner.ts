import type { Plan, SkillDescriptor, ToolDescriptor } from "./types.ts";

export interface PlannerInput {
  objective: string;
  constraints: Record<string, unknown>;
  availableSkills: SkillDescriptor[];
  availableTools: ToolDescriptor[];
  observations: string[];
  completedSteps: string[];
  failedSteps: string[];
}

export interface Planner {
  createPlan(input: PlannerInput): Promise<Plan>;
  replan(input: PlannerInput & { previousPlan: Plan }): Promise<Plan>;
}
