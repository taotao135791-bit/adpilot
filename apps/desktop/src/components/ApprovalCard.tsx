import { useState } from "react";
import { approvalDisclosure, isApprovalOpen, riskLevelLabel, type Approval, type ApprovalDisclosureEntry } from "../approvalDisclosure.js";
import {
  approvalStatusLabel,
  approvalStatusTone,
  formatTime,
  operationLabel,
  riskLevelTone,
  type AppLocale,
  type ConsoleCopy
} from "../labels.js";
import { Badge, Button } from "../ui.js";
import { IconChevronDown, IconShieldCheck } from "../icons.js";

/**
 * One approval request as an inline conversation-feed card (Codex approval
 * pattern). The collapsed state carries the decision itself — operation,
 * campaign, current → proposed, risk level, and the action buttons. The
 * four disclosure sections open one level down, and the engineering
 * identifiers (fingerprints, IDs, schema versions — the entries rendered in
 * mono) sit one level deeper under "Technical details".
 */
export function ApprovalCard({ approval, locale, copy, onRiskReview, onApprove, onCommit }: {
  approval: Approval;
  locale: AppLocale;
  copy: ConsoleCopy;
  onRiskReview: (approval: Approval) => void;
  onApprove: (approval: Approval) => void;
  onCommit: (approval: Approval) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const sections = approvalDisclosure(approval, locale).map((section) => ({
    title: section.title,
    human: section.entries.filter((entry) => !entry.mono),
    technical: section.entries.filter((entry) => entry.mono)
  }));
  const open = isApprovalOpen(approval.status);

  return (
    <article className="approval-card" data-approval={approval.id} data-open={open}>
      <div className="message-avatar approval-avatar" aria-hidden="true"><IconShieldCheck size={14} /></div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{operationLabel(approval.operation.operation, locale)}</strong>
          <Badge tone={riskLevelTone(approval.operation.riskLevel)} variant="outline">{riskLevelLabel(approval.operation.riskLevel, locale)}</Badge>
          <Badge tone={approvalStatusTone(approval.status)} variant="soft">{approvalStatusLabel(approval.status, locale)}</Badge>
          {approval.createdAt && <time>{formatTime(approval.createdAt, locale)}</time>}
        </header>
        <p className="approval-campaign">{approval.operation.campaign}</p>
        <dl className="approval-delta">
          <div>
            <dt>{copy.current}</dt>
            <dd>{String(approval.operation.currentValue)}</dd>
          </div>
          <span className="delta-arrow" aria-hidden="true">→</span>
          <div>
            <dt>{copy.proposed}</dt>
            <dd>{String(approval.operation.proposedValue)}</dd>
          </div>
        </dl>

        {expanded && (
          <div className="approval-disclosure" aria-label={copy.approvalDisclosure}>
            {sections.filter((section) => section.human.length > 0).map((section) => (
              <section className="approval-disclosure-section" key={section.title}>
                <h3>{section.title}</h3>
                <dl>{section.human.map((item) => <DisclosureRow item={item} key={item.label} />)}</dl>
              </section>
            ))}
            <button
              type="button"
              className="approval-technical-toggle"
              aria-expanded={showTechnical}
              onClick={() => setShowTechnical((value) => !value)}
            >
              <IconChevronDown size={13} />
              <span>{copy.technicalDetails}</span>
            </button>
            {showTechnical && sections.filter((section) => section.technical.length > 0).map((section) => (
              <section className="approval-disclosure-section technical" key={section.title}>
                <h3>{section.title}</h3>
                <dl>{section.technical.map((item) => <DisclosureRow item={item} key={item.label} />)}</dl>
              </section>
            ))}
          </div>
        )}

        <div className="approval-actions">
          <Button size="sm" variant="subtle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? copy.collapse : copy.details}
          </Button>
          {approval.status === "pending_risk_review" && <Button size="sm" variant="outline" onClick={() => onRiskReview(approval)}>{copy.runRisk}</Button>}
          {approval.status === "pending_user" && <Button size="sm" variant="primary" onClick={() => onApprove(approval)}>{copy.approveOnce}</Button>}
          {approval.status === "approved" && (
            <Button size="sm" variant="primary" disabled={!approval.executionPlan} onClick={() => onCommit(approval)}>
              {approval.executionPlan ? copy.executeApproved : copy.missingPlan}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function DisclosureRow({ item }: { item: ApprovalDisclosureEntry }) {
  return (
    <div>
      <dt>{item.label}</dt>
      <dd
        className={item.mono ? "approval-mono" : undefined}
        title={item.fullValue}
        aria-label={item.fullValue ? `${item.label}: ${item.fullValue}` : undefined}
      >
        {item.value}
      </dd>
    </div>
  );
}
