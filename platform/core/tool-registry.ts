import { CoreError } from "./errors.ts";
import type { ToolDescriptor } from "./types.ts";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  register(descriptor: ToolDescriptor): void {
    if (this.tools.has(descriptor.name)) throw new CoreError("TOOL_ERROR", `Tool already registered: ${descriptor.name}`);
    this.tools.set(descriptor.name, descriptor);
  }

  get(name: string): ToolDescriptor {
    const descriptor = this.tools.get(name);
    if (!descriptor) throw new CoreError("TOOL_ERROR", `Unknown tool: ${name}`);
    return descriptor;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  byCapability(capability: string): ToolDescriptor[] {
    return this.list().filter((tool) => tool.capabilities.includes(capability));
  }
}
