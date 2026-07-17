import { modeToolCeiling, type AgentRunPhase, type ConversationMode, type ToolCapability, type ToolDefinition } from "@socrates/core";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(definitions: readonly ToolDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) throw new Error(`duplicate_tool:${definition.name}`);
    this.tools.set(definition.name, definition);
  }

  resolve(name: string, generation: number): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown_tool:${name}`);
    if (tool.generation !== generation) throw new Error(`stale_tool_generation:${name}`);
    return tool;
  }

  available(input: { mode: ConversationMode; phase: AgentRunPhase; allowedCapabilities: ToolCapability[] }): ToolDefinition[] {
    const ceiling = new Set(modeToolCeiling(input.mode, input.phase));
    const allowed = new Set(input.allowedCapabilities);
    return [...this.tools.values()]
      .filter((tool) => ceiling.has(tool.capability) && allowed.has(tool.capability))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
