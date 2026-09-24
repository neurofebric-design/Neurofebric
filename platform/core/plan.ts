import { CoreError } from "./errors.ts";
import type { Plan, PlanStep, SkillDescriptor, ToolDescriptor } from "./types.ts";

function stepMap(steps: PlanStep[]): Map<string, PlanStep> {
  return new Map(steps.map((step) => [step.stepId, step]));
}

function assertAcyclic(steps: PlanStep[]): void {
  const byId = stepMap(steps);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new CoreError("PLANNING_ERROR", `Cyclic plan dependency at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.stepId);
}

export function validatePlan(plan: Plan, skills: SkillDescriptor[], tools: ToolDescriptor[]): void {
  if (!plan.planId || !plan.objective || plan.steps.length === 0) {
    throw new CoreError("PLANNING_ERROR", "Plan requires planId, objective, and at least one step");
  }
  const byId = stepMap(plan.steps);
  if (byId.size !== plan.steps.length) throw new CoreError("PLANNING_ERROR", "Plan step IDs must be unique");
  const skillNames = new Set(skills.map((skill) => skill.name));
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const step of plan.steps) {
    if (!step.expectedOutput || step.validationCriteria.length === 0) {
      throw new CoreError("PLANNING_ERROR", `Step ${step.stepId} requires expected output and validation criteria`);
    }
    if (step.skill && !skillNames.has(step.skill)) throw new CoreError("SKILL_ERROR", `Unknown skill: ${step.skill}`);
    for (const tool of step.tools) if (!toolNames.has(tool)) throw new CoreError("TOOL_ERROR", `Unknown tool: ${tool}`);
    for (const dependency of step.dependencies) {
      if (!byId.has(dependency)) throw new CoreError("PLANNING_ERROR", `Unknown dependency: ${dependency}`);
    }
  }
  assertAcyclic(plan.steps);
}

export function readySteps(plan: Plan, completed: string[]): PlanStep[] {
  const done = new Set(completed);
  return plan.steps.filter((step) => step.status === "PENDING" && step.dependencies.every((dependency) => done.has(dependency)));
}
