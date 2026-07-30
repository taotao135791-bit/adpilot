import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { z } from "zod";
import type { AgentExecutionContext } from "./context.js";
import type { AgentToolDeps } from "./deps.js";
import { zodToJsonSchema } from "./json-schema.js";
import { permissionGranted, runAgentToolCall } from "./lifecycle.js";
import type { AgentToolResult } from "./result.js";

export type AgentToolPermission = "read" | "write" | "destructive" | "computer-use";

/**
 * One registry entry. Names are dot-namespaced (`project.get_context`),
 * descriptions tell the model what the tool does and when to use it, and
 * `capabilityPack` + `permission` drive both visibility filtering and the
 * lifecycle's second permission gate.
 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  capabilityPack: string;
  permission: AgentToolPermission;
  parameters: z.ZodType<unknown>;
  execute(params: unknown, ctx: AgentExecutionContext, deps: AgentToolDeps): Promise<AgentToolResult>;
}

/** Packs every execution context may use without explicit enablement. */
export const ALWAYS_ON_PACKS: readonly string[] = ["project", "goal", "task"];

/**
 * Unified Agent Tool Registry. Holds every 0.3 capability as a typed tool
 * definition and projects them onto the Pi runtime:
 *
 * - `list(ctx)` filters by capability pack (always-on packs plus
 *   ctx.enabledCapabilityPacks) and by permission (write tools are invisible
 *   when ctx.permissions.write is false; destructive and computer-use tools
 *   likewise), so the model only ever sees what it may use.
 * - `toPiTools(ctx, deps)` converts the visible definitions into pi-agent-core
 *   AgentTools: the zod contract becomes the JSON-Schema parameter
 *   description, and every invocation flows through the shared lifecycle
 *   (permission re-check, parse, audit, task write-back, unified result).
 */
export class AgentToolRegistry {
  private readonly definitions = new Map<string, AgentToolDefinition>();

  register(definition: AgentToolDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`duplicate agent tool registration: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  registerAll(definitions: Iterable<AgentToolDefinition>): void {
    for (const definition of definitions) this.register(definition);
  }

  get(name: string): AgentToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** All registered names, sorted. */
  names(): string[] {
    return [...this.definitions.keys()].sort((left, right) => left.localeCompare(right));
  }

  /** Tools visible under this execution context, sorted by name. */
  list(ctx: AgentExecutionContext): AgentToolDefinition[] {
    const packs = new Set([...ALWAYS_ON_PACKS, ...ctx.enabledCapabilityPacks]);
    return [...this.definitions.values()]
      .filter((definition) => packs.has(definition.capabilityPack) && permissionGranted(definition.permission, ctx.permissions))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Project the visible tools into pi-agent-core AgentTools for a Pi run. */
  toPiTools(ctx: AgentExecutionContext, deps: AgentToolDeps): AgentTool[] {
    return this.list(ctx).map((definition): AgentTool => ({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: zodToJsonSchema(definition.parameters) as unknown as TSchema,
      // Registry tools mutate shared stores and audit per call; keep them sequential.
      executionMode: "sequential",
      execute: async (_toolCallId, rawParams) => {
        const result = await runAgentToolCall(definition, rawParams, ctx, deps);
        return {
          content: [
            { type: "text", text: JSON.stringify(result) },
            ...(result.image ? [{ type: "image" as const, data: result.image.data, mimeType: result.image.mimeType }] : [])
          ],
          details: result
        };
      }
    }));
  }
}
