export { AgentExecutionContext, AgentExecutionPermissions } from "./context.js";
export type { AgentToolDeps } from "./deps.js";
export { toolError } from "./errors.js";
export { zodToJsonSchema } from "./json-schema.js";
export { runAgentToolCall } from "./lifecycle.js";
export {
  AgentToolRegistry,
  ALWAYS_ON_PACKS,
  type AgentToolDefinition,
  type AgentToolPermission
} from "./registry.js";
export {
  EXECUTION_FAILED,
  INVALID_PARAMS,
  PERMISSION_DENIED,
  errorCodeOf,
  recoverableForCode,
  succeed,
  type AgentToolError,
  type AgentToolResult
} from "./result.js";

import { AgentToolRegistry } from "./registry.js";
import { createAdsTools } from "./groups/ads.js";
import { createArtifactTools } from "./groups/artifact.js";
import { createAutomationTools } from "./groups/automation.js";
import { createCodeTerminalTools } from "./groups/code-terminal.js";
import { createGitTools } from "./groups/git.js";
import { createGoalTools } from "./groups/goal.js";
import { createProjectTools } from "./groups/project.js";
import { createTaskTools } from "./groups/task.js";
import { createWorkflowTools } from "./groups/workflow.js";
import { createComputerTools } from "./groups/computer.js";

export { createAdsTools } from "./groups/ads.js";
export { createArtifactTools } from "./groups/artifact.js";
export { createAutomationTools } from "./groups/automation.js";
export { createCodeTerminalTools } from "./groups/code-terminal.js";
export { createGitTools } from "./groups/git.js";
export { createGoalTools } from "./groups/goal.js";
export { createProjectTools } from "./groups/project.js";
export { createTaskTools } from "./groups/task.js";
export { createWorkflowTools } from "./groups/workflow.js";
export { createComputerTools } from "./groups/computer.js";

/** Registry holding every 0.3 capability tool group. */
export function buildAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  registry.registerAll(createProjectTools());
  registry.registerAll(createGoalTools());
  registry.registerAll(createTaskTools());
  registry.registerAll(createCodeTerminalTools());
  registry.registerAll(createGitTools());
  registry.registerAll(createArtifactTools());
  registry.registerAll(createAdsTools());
  registry.registerAll(createAutomationTools());
  registry.registerAll(createWorkflowTools());
  registry.registerAll(createComputerTools());
  return registry;
}
