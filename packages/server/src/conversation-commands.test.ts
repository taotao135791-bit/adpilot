import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { createAdPilotSystem } from "@adpilot/application";
import type { ApprovalOperation } from "@adpilot/approvals";
import { ConversationMessage } from "@adpilot/shared";
import { createServer } from "./index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "adpilot-commands-"));
  const faux = fauxProvider({ provider: "test", models: [{ id: "code", input: ["text", "image"] }] });
  const models = createModels(); models.setProvider(faux.provider);
  const system = await createAdPilotSystem({
    workspaceRoot: root,
    // Hermetic user-extension home: real ~/.adpilot content never leaks into tests.
    adpilotHome: join(root, "home"),
    env: { ADPILOT_FAST_PROVIDER: "test", ADPILOT_FAST_MODEL: "code", ADPILOT_STRONG_PROVIDER: "test", ADPILOT_STRONG_MODEL: "code" },
    models
  });
  const server = await createServer(system, { uiRoot: join(root, "missing-ui") });
  return { root, faux, system, server };
}

function operation(): ApprovalOperation {
  return {
    platform: "google_ads", account: "acct", campaign: "campaign-a", operation: "set_daily_budget",
    currentValue: 100, proposedValue: 110, changePercentage: 10,
    reason: "controlled increase", evidence: ["workspace:baseline"], expectedImpact: "more volume",
    observationWindow: "7 days", rollbackCondition: "CPA exceeds 12", riskLevel: "mutate"
  };
}

async function conversationLog(system: Awaited<ReturnType<typeof createAdPilotSystem>>, conversationId: string) {
  return (await system.workspace.readJsonl("personal", "conversation.jsonl", ConversationMessage))
    .filter((message) => message.conversationId === conversationId);
}

describe("slash commands over HTTP", { timeout: 60_000 }, () => {
  it("answers /approvals deterministically without any model call", async () => {
    const { faux, system, server } = await setup();
    const seeded = operation();
    await system.approvals.create("personal", crypto.randomUUID(), seeded, undefined, {
      input: {
        kind: "budget", currentValue: 100, proposedValue: 110, maxChangePercent: 20,
        activeExperimentVariables: [], measurementStatus: "reliable", mature: true, learning: false
      },
      evidenceFactIds: ["fact-measurement", "fact-maturity", "fact-learning"],
      singleVariable: true
    });

    const response = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/approvals" } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.task).toBeNull();
    expect(body.message).toMatchObject({ role: "system", status: "complete", conversationId: "primary" });
    expect(body.message.content).toContain("# 审批历史");
    expect(body.message.content).toContain("campaign-a");
    expect(body.message.content).toContain("100 → 110");
    expect(faux.state.callCount).toBe(0);

    const log = await conversationLog(system, "primary");
    expect(log.map((message) => message.role)).toEqual(["user", "system"]);
    expect(log[0]?.content).toBe("/approvals");
    await server.close();
  });

  it("answers /skills and /help deterministically from the capability inventory", async () => {
    const { faux, server } = await setup();
    const skills = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/skills", locale: "en" } });
    expect(skills.statusCode).toBe(201);
    expect(skills.json().message.content).toContain("# Capabilities");
    expect(skills.json().message.content).toContain("- daily-report:");
    expect(skills.json().message.content).toContain("- account-audit:");
    expect(skills.json().message.content).toContain("- ads-google:");

    const help = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/help" } });
    expect(help.statusCode).toBe(201);
    expect(help.json().message.content).toContain("# 斜杠命令");
    expect(help.json().message.content).toContain("/report daily");
    expect(faux.state.callCount).toBe(0);
    await server.close();
  });

  it("explains unknown and malformed commands with a /help hint, still without a model call", async () => {
    const { faux, server } = await setup();
    const unknown = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/bogus" } });
    expect(unknown.statusCode).toBe(201);
    expect(unknown.json().message.content).toContain("未知命令:/bogus");
    expect(unknown.json().message.content).toContain("/help");

    const missing = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/report" } });
    expect(missing.json().message.content).toContain("缺少参数");
    const invalid = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/report monthly" } });
    expect(invalid.json().message.content).toContain('"monthly"');
    expect(faux.state.callCount).toBe(0);
    await server.close();
  });

  it("expands /report daily into the normal investigation pipeline with the original command preserved", async () => {
    const { faux, system, server } = await setup();
    let decisionContext = "";
    faux.setResponses([
      (context) => {
        decisionContext = JSON.stringify(context.messages);
        return fauxAssistantMessage('{"mode":"investigate","reply":"Generating the daily report.","goal":"Produce today\'s daily performance report"}');
      },
      fauxAssistantMessage(JSON.stringify({
        summary: "Daily report ready.",
        investigationTree: [{ question: "Collect verified metrics", specialist: "reporting_analyst", status: "complete", conclusion: "done" }],
        evidence: [], hypotheses: [], nextStep: "Review the report", proposedApprovalIds: [], reviewAt: null
      }))
    ]);
    const response = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/report daily", locale: "en" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().message).toMatchObject({ role: "assistant", content: "Daily report ready." });

    // The model received the advisory expansion, not the bare command…
    expect(decisionContext).toContain("/report daily");
    expect(decisionContext).toContain("daily-report");
    expect(decisionContext).toContain("reporting_analyst");
    expect(decisionContext).toContain("grants no extra authority");
    // …while the transcript preserves exactly what the user typed.
    const log = await conversationLog(system, "primary");
    expect(log.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(log[0]?.content).toBe("/report daily");
    await server.close();
  });

  it("expands a user prompt template through the same advisory pipeline and lists it in /help", async () => {
    const { root, faux, system, server } = await setup();
    await mkdir(join(root, "home", "prompts"), { recursive: true });
    await writeFile(join(root, "home", "prompts", "review.md"), [
      "---",
      "description: 复核一份客户报表",
      "argument-hint: \"<name>\"",
      "---",
      "复核 $1 这份报表,先核对指标再核对格式。",
      ""
    ].join("\n"));

    let decisionContext = "";
    faux.setResponses([(context) => {
      decisionContext = JSON.stringify(context.messages);
      return fauxAssistantMessage('{"mode":"answer","reply":"复核完成。","goal":null}');
    }]);
    const response = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/review 周报" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().message).toMatchObject({ role: "assistant", content: "复核完成。" });

    // The model received the expanded template wrapped in the advisory framing…
    expect(decisionContext).toContain("用户自定义 prompt 模板");
    expect(decisionContext).toContain("复核 周报 这份报表,先核对指标再核对格式。");
    expect(decisionContext).toContain("不授予任何额外权限");
    // …while the transcript preserves exactly what the user typed.
    const log = await conversationLog(system, "primary");
    expect(log.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(log[0]?.content).toBe("/review 周报");

    // /help merges the user command with its argument hint, without a model call.
    const callsBeforeHelp = faux.state.callCount;
    const help = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/help" } });
    expect(help.json().message.content).toContain("用户 prompt 模板");
    expect(help.json().message.content).toContain("- /review <name> — 复核一份客户报表");
    expect(faux.state.callCount).toBe(callsBeforeHelp);
    await server.close();
  });

  it("keeps the built-in command ahead of a conflicting user template", async () => {
    const { root, faux, server } = await setup();
    await mkdir(join(root, "home", "prompts"), { recursive: true });
    await writeFile(join(root, "home", "prompts", "report.md"), "---\ndescription: 用户自定义 report 模板\n---\nUSER_TEMPLATE_MARKER $1\n");

    let decisionContext = "";
    faux.setResponses([
      (context) => {
        decisionContext = JSON.stringify(context.messages);
        return fauxAssistantMessage('{"mode":"investigate","reply":"Generating.","goal":"Produce the daily report"}');
      },
      fauxAssistantMessage(JSON.stringify({
        summary: "Daily report ready.",
        investigationTree: [{ question: "Collect verified metrics", specialist: "reporting_analyst", status: "complete", conclusion: "done" }],
        evidence: [], hypotheses: [], nextStep: "Review", proposedApprovalIds: [], reviewAt: null
      }))
    ]);
    const response = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "/report daily", locale: "en" } });
    expect(response.statusCode).toBe(201);

    // The built-in expansion runs; the user template body never reaches the model.
    expect(decisionContext).toContain("daily-report");
    expect(decisionContext).not.toContain("USER_TEMPLATE_MARKER");
    await server.close();
  });
});

describe("conversation fork over HTTP", { timeout: 60_000 }, () => {
  it("forks a conversation at a user message and both branches evolve independently", async () => {
    const { faux, system, server } = await setup();
    faux.setResponses([fauxAssistantMessage('{"mode":"answer","reply":"First answer.","goal":null}')]);
    const first = await server.inject({ method: "POST", url: "/api/messages", payload: { message: "First question", locale: "en" } });
    expect(first.statusCode).toBe(201);
    const state = await server.inject({ method: "GET", url: "/api/state" });
    const userMessageId = (state.json().messages as Array<{ id: string; role: string }>).find((message) => message.role === "user")?.id;
    expect(userMessageId).toBeTruthy();

    const fork = await server.inject({ method: "POST", url: `/api/clients/personal/conversations/primary/fork`, payload: { atMessageId: userMessageId } });
    expect(fork.statusCode).toBe(201);
    const forked = fork.json();
    expect(forked.conversationId).toMatch(/^fork-/);
    expect(forked.copiedMessages).toBe(1);

    // The new conversation holds the shared prefix; the source is untouched.
    const forkState = await server.inject({ method: "GET", url: `/api/state?conversationId=${forked.conversationId}` });
    expect(forkState.json().messages).toMatchObject([{ role: "user", content: "First question" }]);
    expect(forkState.json().conversations).toEqual(expect.arrayContaining(["primary", forked.conversationId]));

    // The fork keeps chatting with the shared history while primary stays put.
    let forkContext = "";
    faux.setResponses([(context) => {
      forkContext = JSON.stringify(context.messages);
      return fauxAssistantMessage('{"mode":"answer","reply":"Fork answer.","goal":null}');
    }]);
    const continued = await server.inject({ method: "POST", url: "/api/messages", payload: { conversationId: forked.conversationId, message: "Different strategy", locale: "en" } });
    expect(continued.statusCode).toBe(201);
    expect(forkContext).toContain("First question");
    expect(forkContext).not.toContain("First answer.");

    const primaryState = await server.inject({ method: "GET", url: "/api/state" });
    expect(primaryState.json().messages).toHaveLength(2);
    const forkStateAfter = await server.inject({ method: "GET", url: `/api/state?conversationId=${forked.conversationId}` });
    expect(forkStateAfter.json().messages).toHaveLength(3);

    // The fork is chained into the audit log.
    const audit = await system.audit.list("personal");
    expect(audit.filter((event) => event.action === "fork_conversation")).toHaveLength(1);
    await server.close();
  });

  it("rejects unknown or cross-conversation fork targets", async () => {
    const { faux, server } = await setup();
    faux.setResponses([fauxAssistantMessage('{"mode":"answer","reply":"Answer.","goal":null}')]);
    await server.inject({ method: "POST", url: "/api/messages", payload: { message: "Question", locale: "en" } });

    const unknown = await server.inject({ method: "POST", url: "/api/clients/personal/conversations/primary/fork", payload: { atMessageId: crypto.randomUUID() } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("FORK_TARGET_NOT_FOUND");

    const foreignMessage = crypto.randomUUID();
    await server.inject({ method: "POST", url: "/api/messages", payload: { conversationId: "other", message: "Elsewhere", locale: "en" } });
    void foreignMessage;
    const state = await server.inject({ method: "GET", url: "/api/state?conversationId=other" });
    const otherUserId = (state.json().messages as Array<{ id: string; role: string }>).find((message) => message.role === "user")?.id;
    const cross = await server.inject({ method: "POST", url: "/api/clients/personal/conversations/primary/fork", payload: { atMessageId: otherUserId } });
    expect(cross.statusCode).toBe(404);

    const invalid = await server.inject({ method: "POST", url: "/api/clients/personal/conversations/primary/fork", payload: { atMessageId: "not-a-uuid" } });
    expect(invalid.statusCode).toBe(400);
    await server.close();
  });
});
