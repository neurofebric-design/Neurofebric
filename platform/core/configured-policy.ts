import path from "node:path";
import { collectStrings } from "./policy.ts";
import { extractCommandText, extractToolPathCandidates } from "./tool-paths.ts";
import { globToRegExp, normalizeForMatch, type PolicyConfig, type RuleVerdict } from "./policy-config.ts";
import { WorkspaceBoundary } from "./workspace.ts";
import type { PolicyDecision, PolicyEngine, PolicyMode, PolicyRequest } from "./types.ts";

/**
 * Policy driven by a validated declarative config.
 *
 * This is the kernel side of the legacy Python harness's policy engine. The
 * conceptual order is unchanged (deny beats allow, then limits, then content
 * patterns, then paths, then write size), and the reasoning behind each step is
 * documented in docs/POLICY_PORT.md.
 *
 * The invariant that matters: `evaluate` here can only ever return DENY. Anything
 * it permits is handed to the wrapped tier policy, which is what decides whether
 * a write needs approval. A config file therefore cannot grant a permission that
 * the trust model would otherwise require approval for.
 */
/**
 * Argument names that carry the payload a write persists. Used for both the
 * secret patterns and the write-size limit, so the two always agree on what
 * "the content" is.
 */
const CONTENT_PARAM_NAMES: ReadonlySet<string> = new Set([
  "content",
  "contents",
  "text",
  "body",
  "data",
  "new_string",
  "old_string",
]);

export class ConfiguredPolicy implements PolicyEngine {
  readonly mode: PolicyMode;
  private readonly config: PolicyConfig;
  private readonly boundary: WorkspaceBoundary;
  private readonly base: PolicyEngine;
  /** Per-task accounting, mirroring the legacy engine's per-run counters. */
  private readonly counters = new Map<string, { toolCalls: number; fileWrites: number }>();
  private readonly matchers: RegExp[];

  constructor(config: PolicyConfig, options: { mode: PolicyMode; base: PolicyEngine; allowedRoots: string[] }) {
    this.config = config;
    this.mode = options.mode;
    this.base = options.base;
    this.boundary = new WorkspaceBoundary(options.allowedRoots);
    this.matchers = config.fileRules.map((rule) => globToRegExp(normalizeForMatch(rule.pattern)));
  }

  /** Drop the accounting for a finished task. Called when a new task begins. */
  forgetTask(taskId: string): void {
    this.counters.delete(taskId);
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const denial = this.evaluateRules(request);
    if (denial) {
      return { decision: "DENY", reason: denial, violation: this.config.onViolation };
    }

    const counts = this.countsFor(request.taskId);
    counts.toolCalls += 1;
    if (request.tool.riskLevel === "WRITE") counts.fileWrites += 1;

    return this.base.evaluate(request);
  }

  async evaluateWithApproval(request: PolicyRequest): Promise<PolicyDecision> {
    const decision = this.evaluate(request);
    if (decision.decision !== "REQUIRE_APPROVAL") return decision;
    // The wrapped engine owns the approval provider; the rules above already ran.
    return this.base.evaluateWithApproval(request);
  }

  private countsFor(taskId: string): { toolCalls: number; fileWrites: number } {
    let counts = this.counters.get(taskId);
    if (!counts) {
      counts = { toolCalls: 0, fileWrites: 0 };
      this.counters.set(taskId, counts);
    }
    return counts;
  }

  /** Accounting for a task, for tests and for the trace. */
  usageFor(taskId: string): { toolCalls: number; fileWrites: number } {
    return this.counters.get(taskId) ?? { toolCalls: 0, fileWrites: 0 };
  }

  /** The declarative rules alone, without the tier policy underneath. */
  private evaluateRules(request: PolicyRequest): string | undefined {
    const { tool, input, taskId } = request;
    const where = `policy ${path.basename(this.config.source)}`;

    // 1. Deny list always wins.
    if (this.config.deniedTools.includes(tool.name)) {
      return `${where}: '${tool.name}' is in deniedTools`;
    }

    // 2. An empty allow list means "no name-based gating", not "allow all".
    if (this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(tool.name)) {
      return `${where}: '${tool.name}' is not in allowedTools`;
    }

    // 3. Limits, checked before the call is counted.
    const counts = this.countsFor(taskId);
    if (counts.toolCalls >= this.config.limits.maxToolCallsPerTask) {
      return `${where}: maxToolCallsPerTask exceeded (${this.config.limits.maxToolCallsPerTask})`;
    }
    if (tool.riskLevel === "WRITE" && counts.fileWrites >= this.config.limits.maxFileWritesPerTask) {
      return `${where}: maxFileWritesPerTask exceeded (${this.config.limits.maxFileWritesPerTask})`;
    }

    // 4. Content patterns, each scoped to the payload it is actually about.
    //
    //    Destructive patterns are matched against COMMAND text, so they fire
    //    whatever the tool's tier. Secret patterns are matched only against the
    //    content a write would persist: searching for a secret is analysis,
    //    writing one is the hazard.
    const commandDenial = this.matchIn(
      this.config.destructiveCommandPatterns,
      collectStrings(extractCommandText(tool, input)),
      "destructive command pattern matched",
      where,
    );
    if (commandDenial) return commandDenial;

    if (tool.riskLevel === "WRITE") {
      const secretDenial = this.matchIn(
        this.config.secretWritePatterns,
        this.contentPayloadStrings(input),
        "secret write pattern matched",
        where,
      );
      if (secretDenial) return secretDenial;
    }

    // 5. Paths. Containment is decided by the boundary, not by the rules, so a
    //    catch-all `**` can only ever mean "somewhere inside an allowed root".
    const pathDenial = this.evaluatePaths(request, where);
    if (pathDenial) return pathDenial;

    // 6. Write size.
    if (tool.riskLevel === "WRITE") {
      const bytes = this.payloadBytes(request);
      if (bytes > this.config.limits.maxBytesPerWrite) {
        return `${where}: maxBytesPerWrite exceeded (${bytes} > ${this.config.limits.maxBytesPerWrite})`;
      }
    }

    return undefined;
  }

  private evaluatePaths(request: PolicyRequest, where: string): string | undefined {
    const candidates = extractToolPathCandidates(request.tool, request.input);
    if (candidates.length === 0) return undefined;

    const writing = request.tool.riskLevel === "WRITE";
    for (const candidate of candidates) {
      const verdict = this.boundary.check(candidate);
      if (!verdict.allowed) {
        return `${where}: path boundary violation: ${candidate}: ${verdict.reason}`;
      }

      const resolved = verdict.resolvedPath ?? candidate;
      const relative = this.relativeToRoots(resolved);
      if (relative === undefined) continue; // inside a root, but not relativisable; containment already passed

      const matched = this.matchRule(normalizeForMatch(relative), writing);
      if (matched === undefined) {
        // Default deny, exactly as the legacy engine's unmatched branch did.
        return `${where}: no matching file rule for '${relative}' (default deny)`;
      }
      if (matched.verdict === "deny") {
        return `${where}: path rule '${matched.pattern}' denies ${writing ? "write" : "read"} of '${relative}'`;
      }
    }
    return undefined;
  }

  /** First matching rule wins. Returns undefined when nothing matches. */
  private matchRule(relative: string, writing: boolean): { pattern: string; verdict: RuleVerdict } | undefined {
    for (const [index, matcher] of this.matchers.entries()) {
      if (matcher.test(relative)) {
        const rule = this.config.fileRules[index];
        return { pattern: rule.pattern, verdict: writing ? rule.write : rule.read };
      }
    }
    return undefined;
  }

  /** The path relative to the first allowed root that contains it. */
  private relativeToRoots(candidate: string): string | undefined {
    for (const root of this.boundary.roots) {
      const relative = path.relative(root, candidate);
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative;
      }
    }
    return undefined;
  }

  /** First pattern present in any of `texts`, as a denial reason. */
  private matchIn(
    patterns: readonly string[],
    texts: readonly string[],
    label: string,
    where: string,
  ): string | undefined {
    for (const pattern of patterns) {
      const needle = pattern.toLowerCase();
      for (const text of texts) {
        if (text.toLowerCase().includes(needle)) {
          return `${where}: ${label}: '${pattern}'`;
        }
      }
    }
    return undefined;
  }

  /**
   * The content a write would actually PERSIST.
   *
   * Only content-bearing arguments are returned. The path and the file mode are
   * deliberately excluded: a file named `passwords.md` is not a secret, and
   * neither is a document that happens to discuss secrets.
   */
  private contentPayloadStrings(input: unknown): string[] {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
    const values: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (CONTENT_PARAM_NAMES.has(key)) values.push(...collectStrings(value));
    }
    return values;
  }

  /**
   * UTF-8 bytes of what the call would actually WRITE.
   *
   * The legacy engine measured `args["content"]`, so only the content-bearing
   * arguments are counted here. Counting the path or the file mode as well would
   * reject writes for reasons that have nothing to do with their size.
   */
  private payloadBytes(request: PolicyRequest): number {
    return this.contentPayloadStrings(request.input)
      .reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }
}

export function isConfiguredPolicy(policy: PolicyEngine): policy is ConfiguredPolicy {
  return policy instanceof ConfiguredPolicy;
}
