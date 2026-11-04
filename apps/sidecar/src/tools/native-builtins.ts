import type { ToolDefinition } from "@socrates/core";
import type { WorkspacePathPolicy } from "../workspace/path-policy";
import { createToolResultReader, type ToolOutputScope, type ToolOutputStore } from "./output-store";
import { createReadOnlyBuiltins } from "./read-only-builtins";
import type { WorkspaceCommandRunner } from "./workspace-command-runner";
import { createWorkspaceWriteBuiltins } from "./workspace-write-builtins";

/** One production registry factory, including session-scoped durable captures. */
export function createNativeBuiltinTools(policy: WorkspacePathPolicy, outputs: ToolOutputStore,
  scope: ToolOutputScope, commandRunner?: WorkspaceCommandRunner): ToolDefinition[] {
  return [
    ...createReadOnlyBuiltins(policy),
    ...createWorkspaceWriteBuiltins(policy, commandRunner,
      (context) => outputs.createCommandCapture(scope, context.toolOperationId)),
    createToolResultReader(outputs, scope),
  ];
}
