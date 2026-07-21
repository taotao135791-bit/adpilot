import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SpecialistCoordinator } from "@adpilot/specialist-agents";
import { SpecialistRole, TaskState, type TaskState as Task } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";

const InvestigationNode = z.object({ question: z.string().min(1), specialist: SpecialistRole, status: z.enum(["pending", "complete", "blocked"]), conclusion: z.string().optional() });
const MainAgentOutput = z.object({ summary: z.string().min(1), investigationTree: z.array(InvestigationNode).min(1), nextStep: z.string().min(1), proposedApprovalIds: z.array(z.string().uuid()).default([]), reviewAt: z.string().datetime().nullable().default(null) });
export type MainAgentOutput = z.infer<typeof MainAgentOutput>;

export class AdPilotAgent {
  constructor(private readonly runtime: PiAgentRuntime, private readonly specialists: SpecialistCoordinator, private readonly workspace: WorkspaceStore) {}

  async startTask(clientId: string, goal: string): Promise<Task> {
    const now = new Date().toISOString();
    const task = TaskState.parse({ id: crypto.randomUUID(), clientId, goal, phase: "intake", createdAt: now, updatedAt: now, nextStep: "Build an evidence-driven investigation tree" });
    await this.workspace.saveTask(task);
    return task;
  }

  async runTask(clientId: string, goal: string, sharedFacts: Record<string, unknown> = {}): Promise<{ task: Task; result: MainAgentOutput; specialistResults: Record<string, unknown> }> {
    let task = await this.startTask(clientId, goal);
    task = TaskState.parse({ ...task, phase: "investigating", owner: null, nextStep: "Dispatch specialists and collect evidence", updatedAt: new Date().toISOString() });
    await this.workspace.saveTask(task);
    const specialistResults: Record<string, unknown> = {};
    const dispatchTool: AgentTool = {
      name: "dispatch_specialist",
      label: "Dispatch an isolated specialist",
      description: "Run one specialist with an isolated context and structured input. Measurement should be reviewed before optimization changes.",
      parameters: Type.Object({ role: Type.Union(SpecialistRole.options.map((role) => Type.Literal(role))), input: Type.Unknown() }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const params = z.object({ role: SpecialistRole, input: z.unknown() }).parse(raw);
        const output = await this.specialists.dispatch(params.role, { context: { clientId, taskId: task.id, actor: "adpilot_agent", permission: "OBSERVE" }, input: params.input, sharedFacts });
        specialistResults[params.role] = output;
        return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
      }
    };
    const result = await this.runtime.runStructured({
      context: { clientId, taskId: task.id, actor: "adpilot_agent", permission: "OBSERVE", sessionId: crypto.randomUUID(), role: "adpilot_agent" },
      systemPrompt: [
        "You are AdPilot Agent, the single user-facing owner of an advertising account.",
        "Maintain the goal and investigation tree, proactively gather evidence, use specialists as bounded experts, and make the final synthesis yourself.",
        "Review measurement reliability before optimization. Never mutate an account from this conversational run.",
        "For operation ideas, create a structured recommendation and leave execution to the approval queue."
      ].join("\n"),
      prompt: JSON.stringify({ goal, sharedFacts, currentTask: task }),
      signals: { task: "planning" }, tools: [dispatchTool]
    }, MainAgentOutput);
    task = TaskState.parse({
      ...task,
      phase: result.proposedApprovalIds.length ? "awaiting_approval" : "completed",
      completedSteps: result.investigationTree.filter((node) => node.status === "complete").map((node) => node.question),
      blockers: result.investigationTree.filter((node) => node.status === "blocked").map((node) => node.conclusion ?? node.question),
      nextStep: result.nextStep, reviewAt: result.reviewAt, updatedAt: new Date().toISOString()
    });
    await this.workspace.saveTask(task);
    await this.workspace.appendJsonl(clientId, "decisions.jsonl", { taskId: task.id, at: new Date().toISOString(), goal, result });
    return { task, result, specialistResults };
  }
}

export { MainAgentOutput };

