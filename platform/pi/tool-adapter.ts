import type { ToolDescriptor } from "../core/types.ts";

export interface PiToolInfoLike {
  name: string;
  description?: string;
  parameters?: unknown;
}

const riskByTool: Record<string, Pick<ToolDescriptor, "riskLevel" | "idempotency" | "sideEffect">> = {
  read: { riskLevel: "READ_ONLY", idempotency: "IDEMPOTENT", sideEffect: "PURE" },
  grep: { riskLevel: "READ_ONLY", idempotency: "IDEMPOTENT", sideEffect: "PURE" },
  find: { riskLevel: "READ_ONLY", idempotency: "IDEMPOTENT", sideEffect: "PURE" },
  ls: { riskLevel: "READ_ONLY", idempotency: "IDEMPOTENT", sideEffect: "PURE" },
  bash: { riskLevel: "CONTROLLED", idempotency: "UNKNOWN", sideEffect: "SIDE_EFFECTING" },
  powershell: { riskLevel: "CONTROLLED", idempotency: "UNKNOWN", sideEffect: "SIDE_EFFECTING" },
  edit: { riskLevel: "WRITE", idempotency: "IDEMPOTENT", sideEffect: "SIDE_EFFECTING" },
  write: { riskLevel: "WRITE", idempotency: "IDEMPOTENT", sideEffect: "SIDE_EFFECTING" },
};

export function toolDescriptorFromPi(info: PiToolInfoLike): ToolDescriptor {
  const classification = riskByTool[info.name] ?? {
    riskLevel: "CONTROLLED" as const,
    idempotency: "UNKNOWN" as const,
    sideEffect: "SIDE_EFFECTING" as const,
  };
  return {
    name: info.name,
    version: "pi-runtime",
    description: info.description ?? `Pi built-in tool: ${info.name}`,
    inputSchema: (info.parameters ?? { type: "object" }) as Record<string, unknown>,
    outputSchema: { type: "object" },
    capabilities: [`tool.${info.name}`],
    permissions: [`tool:${info.name}`],
    ...classification,
    timeoutMs: 120_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  };
}
