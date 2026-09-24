import { CoreError } from "./errors.ts";
import type { PolicyDecision, PolicyRequest } from "./types.ts";

export interface ApprovalProvider {
  requestApproval(request: PolicyRequest): Promise<boolean>;
}

export class DefaultPolicy {
  private readonly approval?: ApprovalProvider;

  constructor(approval?: ApprovalProvider) {
    this.approval = approval;
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    if (request.tool.riskLevel === "DESTRUCTIVE") {
      if (request.approval === true) return { decision: "ALLOW" };
      return { decision: "REQUIRE_APPROVAL", reason: "Destructive operations require explicit approval" };
    }
    if (request.tool.sideEffect === "SIDE_EFFECTING" && request.tool.riskLevel === "WRITE") {
      return { decision: "REQUIRE_APPROVAL", reason: "Write operations require explicit approval" };
    }
    if (request.tool.riskLevel === "READ_ONLY") return { decision: "ALLOW" };
    return { decision: "DENY", reason: "No policy rule allows this operation" };
  }

  async evaluateWithApproval(request: PolicyRequest): Promise<PolicyDecision> {
    const decision = this.evaluate(request);
    if (decision.decision !== "REQUIRE_APPROVAL") return decision;
    if (!this.approval) return decision;
    const approved = await this.approval.requestApproval(request);
    return approved ? { decision: "ALLOW" } : { decision: "DENY", reason: "Approval denied" };
  }
}

export function assertAllowed(decision: PolicyDecision): void {
  if (decision.decision === "DENY") throw new CoreError("POLICY_ERROR", decision.reason);
  if (decision.decision === "REQUIRE_APPROVAL") throw new CoreError("POLICY_ERROR", decision.reason);
}
