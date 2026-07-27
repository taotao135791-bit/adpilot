import {
  alertDeliveryLabel,
  alertKindLabel,
  alertSeverityLabel,
  alertSeverityTone,
  formatTime,
  type AppLocale,
  type ConsoleCopy
} from "../labels.js";
import type { Approval } from "../approvalDisclosure.js";
import type { Audit, ComputerExecutionStatus, ConversationMessage, Experiment } from "../types.js";
import type { TimelineAlert, TimelineItem } from "../conversationTimeline.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { ComputerUseCard, type ComputerControlAction } from "./ComputerUseCard.js";
import { AuditCard, ExperimentsCard } from "./InsightCards.js";
import { Badge, Tooltip } from "../ui.js";
import { IconAlert, IconBot, IconChevronDown, IconError, IconFork, IconHistory, IconInfo } from "../icons.js";

/**
 * The single-column conversation feed: messages, monitoring alerts,
 * approval cards, the live computer-use card, and on-demand insight cards
 * in one chronological stream. Item kinds are pre-merged and pre-sorted by
 * conversationTimeline.ts; this component only renders.
 */
export function ConversationFeed({ copy, locale, timeline, experiments, audit, computerMode, guiConfigured, conversationOptions, conversationId, submitting, onSelectConversation, onFork, onRiskReview, onApprove, onCommit, onComputerControl }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  timeline: TimelineItem<ConversationMessage, Approval>[];
  experiments: Experiment[];
  audit: Audit[];
  computerMode: ComputerExecutionStatus;
  guiConfigured: boolean;
  conversationOptions: string[];
  conversationId: string;
  submitting: boolean;
  onSelectConversation: (conversationId: string) => void;
  onFork: (messageId: string) => void;
  onRiskReview: (approval: Approval) => void;
  onApprove: (approval: Approval) => void;
  onCommit: (approval: Approval) => void;
  onComputerControl: (action: ComputerControlAction) => void;
}) {
  return (
    <section className="conversation" aria-label={copy.mission}>
      {conversationOptions.length > 1 && (
        <div className="conversation-bar">
          <IconHistory size={14} />
          <div className="select-wrap">
            <select value={conversationId} aria-label={copy.conversation} onChange={(event) => onSelectConversation(event.target.value)}>
              {conversationOptions.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <IconChevronDown size={12} />
          </div>
        </div>
      )}
      {timeline.map((item) => {
        switch (item.kind) {
          case "alert":
            return <AlertCard alert={item.alert} locale={locale} copy={copy} key={item.id} />;
          case "approval":
            return <ApprovalCard approval={item.approval} locale={locale} copy={copy} onRiskReview={onRiskReview} onApprove={onApprove} onCommit={onCommit} key={item.id} />;
          case "computer":
            return <ComputerUseCard copy={copy} locale={locale} mode={computerMode} computer={item.computer} guiConfigured={guiConfigured} onControl={onComputerControl} key={item.id} />;
          case "insight":
            return item.insight.kind === "experiments"
              ? <ExperimentsCard copy={copy} locale={locale} experiments={experiments} at={item.insight.at} key={item.id} />
              : <AuditCard copy={copy} locale={locale} audit={audit} at={item.insight.at} key={item.id} />;
          default:
            return <MessageItem message={item.message} locale={locale} copy={copy} onFork={onFork} key={item.id} />;
        }
      })}
      {submitting && <div className="thinking"><span className="thinking-pulse" aria-hidden="true" /><span>{copy.investigating}</span></div>}
    </section>
  );
}

function MessageItem({ message, locale, copy, onFork }: {
  message: ConversationMessage;
  locale: AppLocale;
  copy: ConsoleCopy;
  onFork: (messageId: string) => void;
}) {
  const role = message.role;
  const isSystemNotice = role === "system" && message.status === "complete";
  const name = role === "user" ? copy.you : role === "system" ? copy.system : copy.agent;
  return (
    <article className={`message ${role} ${message.status}${isSystemNotice ? " notice" : ""}`}>
      <div className="message-avatar" aria-hidden="true">
        {role === "system"
          ? (message.status === "error" ? <IconError size={14} /> : <IconInfo size={14} />)
          : role === "assistant"
            ? <IconBot size={14} />
            : <span>{locale === "zh-CN" ? "你" : "Y"}</span>}
      </div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{name}</strong>
          <time>{formatTime(message.at, locale)}</time>
          <Tooltip content={copy.forkHere}>
            <button className="message-fork" aria-label={copy.forkHere} onClick={() => onFork(message.id)}>
              <IconFork size={13} />
            </button>
          </Tooltip>
        </header>
        <MessageBody content={message.content} />
      </div>
    </article>
  );
}

/** Monitoring-alert card rendered inside the conversation feed for SSE alert events. */
function AlertCard({ alert, locale, copy }: { alert: TimelineAlert; locale: AppLocale; copy: ConsoleCopy }) {
  return (
    <article className={`alert-card ${alert.severity}`}>
      <div className="message-avatar alert-avatar" aria-hidden="true"><IconAlert size={14} /></div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{copy.alert}</strong>
          <time>{formatTime(alert.createdAt, locale)}</time>
        </header>
        <div className="alert-head">
          <Badge tone={alertSeverityTone(alert.severity)} variant="soft">{alertSeverityLabel(alert.severity, locale)}</Badge>
          <span className="alert-kind">{alertKindLabel(alert.kind, locale)}</span>
          <span className="alert-status">{alertDeliveryLabel(alert.status, locale)}</span>
        </div>
        <p className="alert-message">{alert.message}</p>
        {alert.metricCount > 0 && <small className="alert-metrics">{copy.alertMetrics.replace("{count}", String(alert.metricCount))}</small>}
      </div>
    </article>
  );
}

function MessageBody({ content }: { content: string }) {
  const blocks = content.trim().split(/\n{2,}/);
  return (
    <div className="message-body">
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (block.startsWith("```") && block.endsWith("```")) return <pre key={index}>{block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "")}</pre>;
        if (lines.every((line) => /^[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{line.replace(/^[-*]\s+/, "")}</li>)}</ul>;
        if (lines.every((line) => /^\d+[.)]\s+/.test(line))) return <ol key={index}>{lines.map((line, lineIndex) => <li key={`${index}-${lineIndex}`}>{line.replace(/^\d+[.)]\s+/, "")}</li>)}</ol>;
        if (/^#{1,3}\s+/.test(block)) return <h4 key={index}>{block.replace(/^#{1,3}\s+/, "")}</h4>;
        return <p key={index}>{block}</p>;
      })}
    </div>
  );
}
