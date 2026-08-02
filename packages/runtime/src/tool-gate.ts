import { AuditLog } from "@adpilot/audit";
import type { ApprovalService } from "@adpilot/approvals";
import type { ToolContext } from "@adpilot/tools";
import { classifyToolCall, extractApprovalCredentials, stableJson, type ToolGateRule } from "@adpilot/shared";
import type { PlanModeProbe } from "./plan-mode.js";
import type { AutonomyProbe } from "./autonomy-mode.js";

/**
 * Deterministic write-operation gate enforced in Agent.beforeToolCall.
 *
 * Every model-initiated tool call is classified through TOOL_GATE_RULES
 * (single source of truth in @adpilot/shared). Read calls flow untouched.
 * Write and destructive calls must prove the authority declared by their rule;
 * anything else is blocked before the tool body runs and the denial is chained
 * into the tamper-evident audit log. This removes the previous reliance on each
 * tool policing itself (architecture invariant: model output never bypasses the
 * deterministic guardrails).
 *
 * Plan mode is the one session-level override: while it is enabled for the
 * conversation, every non-read classification is denied outright (the
 * read-only tool shrink is the primary mechanism; this is the deterministic
 * backstop for anything that still reached the model's tool list).
 *
 * Autonomy mode is the client-level counterweight: in `full_access` the gate
 * admits write-classified calls that cannot carry a verifiable action-bound
 * approval token. Destructive classifications — deny shell verdicts, account-
 * mutation dispatches, commit_approved_action — are never waived.
 */
/** Shell surfaces that share the deterministic classifier and absolute deny policy. */
const HARD_DENIED_SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "terminal.execute"]);

export class ToolPermissionGate {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly audit: AuditLog,
    private readonly planMode?: PlanModeProbe,
    private readonly autonomy?: AutonomyProbe
  ) {}

  /**
   * Returns a model-safe denial reason when the call must be blocked, or null
   * when it may proceed. Allowed write/destructive decisions and every denial
   * are appended to the audit hash chain.
   */
  async check(toolName: string, args: unknown, context: ToolContext & { conversationId?: string }): Promise<string | null> {
    const { rule, class: classification, defaulted } = classifyToolCall(toolName, args);
    if (classification === "read") return null;
    const planModeOn = this.planMode && typeof context.conversationId === "string"
      ? await this.planMode.isEnabled(context.clientId, context.conversationId).catch(() => false)
      : false;
    // Query autonomy only for declared Full-Access-only writes. Destructive
    // calls are normalized to token authority by classifyToolCall and can
    // never acquire broader authority merely because Full Access is enabled.
    const fullAccessEligible = !planModeOn && classification === "write"
      && rule.authority === "full_access_only";
    const fullAccessGrant = fullAccessEligible && this.autonomy !== undefined
      ? await this.autonomy.mode(context.clientId).then((mode) => mode === "full_access").catch(() => false)
      : false;
    const hardPolicyDenial = defaulted
      ? `${toolName} is unclassified and hard-denied in every autonomy mode. Register an explicit tool rule and review its side effects before exposing it to the model.`
      : HARD_DENIED_SHELL_TOOLS.has(toolName) && classification === "destructive"
        ? `${toolName} command is hard-denied by AdPilot policy and cannot be authorized in guarded or full-access mode. Use a dedicated bounded product tool instead of launching or capturing other software, networking, controlling processes, or bypassing the shell policy.`
        : null;
    const denial = hardPolicyDenial ?? (planModeOn
      ? `Plan mode is active for this conversation: ${toolName} is a ${classification} operation and only read-only tools are available. Present the numbered plan and ask the user to disable plan mode to execute it.`
      : fullAccessGrant
        ? null
        : await this.authorize(rule, toolName, args, context));
    await this.audit.append({
      clientId: context.clientId,
      taskId: context.taskId,
      actor: context.actor,
      action: "tool_gate",
      status: denial ? "denied" : "succeeded",
      details: {
        tool: toolName,
        classification,
        authority: rule.authority,
        defaulted,
        ...(planModeOn ? { planMode: true } : {}),
        ...(fullAccessGrant ? { autonomy: "full_access", fullAccessOnlyGranted: true } : {}),
        ...(denial ? { reason: denial } : {})
      }
    });
    return denial;
  }

  private async authorize(
    rule: ToolGateRule,
    toolName: string,
    args: unknown,
    context: ToolContext
  ): Promise<string | null> {
    if (rule.authority === "self_gated") return null;
    if (rule.authority === "full_access_only") {
      return `${toolName} has side effects but cannot present a verifiable action-bound approval token. AdPilot blocks it in Guarded mode; a model-supplied approvalId/reference is not authority. Ask the user to enable Full Access for this workspace before retrying.`;
    }
    const credentials = extractApprovalCredentials(args);
    if (!credentials) {
      return `${toolName} is token-gated and the call carried no approvalId. It requires the operator-held, action-bound approvalId and approvalToken.`;
    }
    const approval = await this.approvals.get(context.clientId, credentials.approvalId).catch(() => undefined);
    if (!approval) return `${toolName} referenced an approval that does not exist`;
    if (approval.clientId !== context.clientId || approval.taskId !== context.taskId) {
      return `${toolName} referenced an approval that belongs to a different client or task`;
    }
    return this.authorizeToken(toolName, approval, credentials.approvalToken);
  }

  /**
   * Mirrors the non-destructive checks of ApprovalService.consume: approved
   * status, single-use attempt budget, exact token-binding equality and token
   * expiry. The HMAC signature and nonce hash are still verified inside
   * ApprovalService.consume at execution time, which remains the final
   * authority; the gate only stops calls that could never succeed.
   */
  private authorizeToken(
    toolName: string,
    approval: { status: string; tokenBinding: { expiresAt: string; maxAttempts: number } | null; tokenAttempts: number; tokenExpiresAt: string | null },
    token: string | undefined
  ): string | null {
    if (approval.status !== "approved") return `${toolName} requires an approved approval; the referenced approval is ${approval.status}`;
    if (!token) return `${toolName} requires the approvalToken minted at user approval; tokens are held by the operator, never invented`;
    if (!approval.tokenBinding || approval.tokenAttempts >= approval.tokenBinding.maxAttempts) {
      return `${toolName} referenced an approval whose token attempt budget is exhausted`;
    }
    const parts = token.split(".");
    if (parts.length !== 3) return `${toolName} received a malformed approval token`;
    const [encodedBinding] = parts as [string, string, string];
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encodedBinding, "base64url").toString("utf8"));
    } catch {
      return `${toolName} received a malformed approval token binding`;
    }
    if (stableJson(decoded) !== stableJson(approval.tokenBinding)) {
      return `${toolName} token binding does not match the stored approval binding`;
    }
    const now = Date.now();
    if (!approval.tokenExpiresAt || now >= Date.parse(approval.tokenExpiresAt) || now >= Date.parse(approval.tokenBinding.expiresAt)) {
      return `${toolName} referenced an expired approval token`;
    }
    return null;
  }
}
