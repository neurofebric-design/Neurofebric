import type { ApprovalProvider, PolicyRequest } from "../core/index.ts";

export class PiApprovalProvider implements ApprovalProvider {
  private readonly hasUi: boolean;
  private readonly request: (prompt: string) => Promise<boolean>;

  constructor(hasUi: boolean, request: (prompt: string) => Promise<boolean>) {
    this.hasUi = hasUi;
    this.request = request;
  }

  async requestApproval(policyRequest: PolicyRequest): Promise<boolean> {
    if (!this.hasUi) return false;
    return this.request(`${policyRequest.tool.name} requires approval: ${policyRequest.operation}`);
  }
}
