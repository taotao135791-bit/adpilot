import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { ApprovalExecutionPlan, ApprovalOperation } from "@adpilot/approvals";
import { PiAgentRuntime } from "@adpilot/runtime";
import { SpecialistCoordinator } from "@adpilot/specialist-agents";
import { Evidence, SpecialistRole, TaskState, type TaskState as Task } from "@adpilot/shared";
import { WorkspaceStore } from "@adpilot/workspace";
import { AdPilotTools } from "@adpilot/tools";

const InvestigationNode = z.object({ question: z.string().min(1), specialist: SpecialistRole, status: z.enum(["pending", "complete", "blocked"]), conclusion: z.string().optional() });
const MainAgentOutput = z.object({
  summary: z.string().min(1), investigationTree: z.array(InvestigationNode).min(1),
  evidence: z.array(Evidence).default([]), hypotheses: z.array(z.string().min(1)).default([]),
  nextStep: z.string().min(1), proposedApprovalIds: z.array(z.string().uuid()).default([]),
  reviewAt: z.string().datetime().nullable().default(null)
});
const LongTermMemory = z.object({
  taskId: z.string().uuid(), at: z.string().datetime(), goal: z.string().min(1), summary: z.string().min(1),
  nextStep: z.string().min(1), reviewAt: z.string().datetime().nullable(), proposedApprovalIds: z.array(z.string().uuid())
});
export type MainAgentOutput = z.infer<typeof MainAgentOutput>;

export class AdPilotAgent {
  constructor(
    private readonly runtime: PiAgentRuntime,
    private readonly specialists: SpecialistCoordinator,
    private readonly workspace: WorkspaceStore,
    private readonly tools: AdPilotTools,
    private readonly onTaskState: (task: Task) => void | Promise<void> = () => undefined
  ) {}

  async startTask(clientId: string, goal: string): Promise<Task> {
    const now = new Date().toISOString();
    const task = TaskState.parse({ id: crypto.randomUUID(), clientId, goal, phase: "intake", createdAt: now, updatedAt: now, nextStep: "Build an evidence-driven investigation tree" });
    await this.persistTask(task);
    return task;
  }

  async runTask(clientId: string, goal: string, sharedFacts: Record<string, unknown> = {}): Promise<{ task: Task; result: MainAgentOutput; specialistResults: Record<string, unknown> }> {
    const [clientContext, memory] = await Promise.all([
      this.workspace.readClient(clientId),
      this.workspace.readJsonl(clientId, "memory/agent.jsonl", LongTermMemory)
    ]);
    const projectFacts = { client: clientContext, supplied: sharedFacts, recentMemory: memory.slice(-20) };
    let task = await this.startTask(clientId, goal);
    task = TaskState.parse({ ...task, phase: "investigating", owner: null, nextStep: "Dispatch specialists and collect evidence", updatedAt: new Date().toISOString() });
    await this.persistTask(task);
    const specialistResults: Record<string, unknown> = {};
    const createdApprovalIds: string[] = [];
    const dispatchTool: AgentTool = {
      name: "dispatch_specialist",
      label: "Dispatch an isolated specialist",
      description: "Run one specialist with an isolated context and structured input. Measurement should be reviewed before optimization changes.",
      parameters: Type.Object({ role: Type.Union(SpecialistRole.options.map((role) => Type.Literal(role))), input: Type.Unknown() }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const params = z.object({ role: SpecialistRole, input: z.unknown() }).parse(raw);
        task = TaskState.parse({ ...task, owner: params.role, updatedAt: new Date().toISOString() });
        await this.persistTask(task);
        const output = await this.specialists.dispatch(params.role, { context: { clientId, taskId: task.id, actor: "adpilot_agent", permission: "OBSERVE" }, input: params.input, sharedFacts: projectFacts });
        specialistResults[params.role] = output;
        task = TaskState.parse({ ...task, owner: null, updatedAt: new Date().toISOString() });
        await this.persistTask(task);
        return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
      }
    };
    const prepareApprovalTool: AgentTool = {
      name: "prepare_approval",
      label: "Prepare an approval request",
      description: "Persist one exact, evidence-backed advertising operation and its visual execution plan. This does not approve or execute it.",
      parameters: Type.Object({ operation: Type.Unknown(), executionPlan: Type.Unknown() }),
      executionMode: "sequential",
      execute: async (_id, raw) => {
        const params = z.object({ operation: ApprovalOperation, executionPlan: ApprovalExecutionPlan }).parse(raw);
        const approval = await this.tools.createApproval({ clientId, taskId: task.id, actor: "adpilot_agent", permission: "OBSERVE" }, params.operation, params.executionPlan);
        createdApprovalIds.push(approval.id);
        return { content: [{ type: "text", text: JSON.stringify({ approvalId: approval.id, status: approval.status }) }], details: { approvalId: approval.id, status: approval.status } };
      }
    };
    let modelResult: MainAgentOutput;
    try {
      modelResult = await this.runtime.runStructured({
        context: { clientId, taskId: task.id, actor: "adpilot_agent", permission: "OBSERVE", sessionId: crypto.randomUUID(), role: "adpilot_agent" },
        systemPrompt: [
          "You are AdPilot Agent, the single user-facing owner of an advertising account.",
          "Maintain the goal and investigation tree, proactively gather evidence, use specialists as bounded experts, and make the final synthesis yourself.",
          "Use projectFacts.supplied.interfaceLocale for every user-facing summary, hypothesis, conclusion, blocker, and next step. Use Simplified Chinese for zh-CN and English for en.",
          "Review measurement reliability before optimization. Never mutate an account from this conversational run.",
          "For an executable operation, use prepare_approval exactly once per single-variable change. Never invent an approval id and never execute from this run."
        ].join("\n"),
        prompt: JSON.stringify({ goal, projectFacts, currentTask: task }),
        signals: { task: "planning" }, tools: [dispatchTool, prepareApprovalTool]
      }, MainAgentOutput);
    } catch (error) {
      const blocker = error instanceof Error ? error.message : String(error);
      task = TaskState.parse({ ...task, phase: "blocked", owner: null, blockers: [...task.blockers, blocker], nextStep: "Resolve the recorded blocker and retry", updatedAt: new Date().toISOString() });
      await this.persistTask(task);
      throw error;
    }
    const result = MainAgentOutput.parse({ ...modelResult, proposedApprovalIds: createdApprovalIds });
    task = TaskState.parse({
      ...task,
      phase: result.proposedApprovalIds.length ? "awaiting_approval" : "completed",
      completedSteps: result.investigationTree.filter((node) => node.status === "complete").map((node) => node.question),
      evidence: result.evidence,
      hypotheses: result.hypotheses,
      blockers: result.investigationTree.filter((node) => node.status === "blocked").map((node) => node.conclusion ?? node.question),
      nextStep: result.nextStep, reviewAt: result.reviewAt, updatedAt: new Date().toISOString()
    });
    await this.persistTask(task);
    await this.workspace.appendJsonl(clientId, "decisions.jsonl", { taskId: task.id, at: new Date().toISOString(), goal, result });
    await this.workspace.appendJsonl(clientId, "memory/agent.jsonl", LongTermMemory.parse({
      taskId: task.id, at: new Date().toISOString(), goal, summary: result.summary,
      nextStep: result.nextStep, reviewAt: result.reviewAt, proposedApprovalIds: result.proposedApprovalIds
    }));
    return { task, result, specialistResults };
  }

  private async persistTask(task: Task): Promise<void> {
    await this.workspace.saveTask(task);
    await this.onTaskState(task);
  }
}

export { MainAgentOutput };
