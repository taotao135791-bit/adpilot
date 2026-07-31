import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
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
import { Badge, Button, Tooltip } from "../ui.js";
import { IconAlert, IconBot, IconChevronDown, IconError, IconFork, IconInfo } from "../icons.js";

const LATEST_THRESHOLD_PX = 72;

export type TimelineUpdateKind = "initial" | "unchanged" | "append" | "mutate" | "replace";

export type MessageBlock =
  | { kind: "paragraph"; content: string }
  | { kind: "heading"; content: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "code"; content: string; language?: string };

export type InlineMarkdownToken =
  | { kind: "text"; content: string }
  | { kind: "strong"; content: string }
  | { kind: "code"; content: string }
  | { kind: "link"; content: string; href: string };

type ClipboardWriter = { writeText: (value: string) => Promise<void> };

type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isConversationNearLatest(metrics: ScrollMetrics, threshold = LATEST_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function classifyTimelineUpdate(previousIds: readonly string[], nextIds: readonly string[]): TimelineUpdateKind {
  if (previousIds.length === 0) return "initial";
  if (previousIds.length === nextIds.length && previousIds.every((id, index) => id === nextIds[index])) {
    return "unchanged";
  }
  if (nextIds.length > previousIds.length && previousIds.every((id, index) => id === nextIds[index])) {
    return "append";
  }
  const next = new Set(nextIds);
  if (!previousIds.some((id) => next.has(id))) return "replace";
  return "mutate";
}

export function shouldFollowConversation(
  update: TimelineUpdateKind,
  wasNearLatest: boolean,
  conversationChanged: boolean
): boolean {
  return conversationChanged || update === "initial" || update === "replace" || wasNearLatest;
}

export function isSafeMarkdownHref(href: string): boolean {
  try {
    const protocol = new URL(href).protocol.toLowerCase();
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

export function parseInlineMarkdown(content: string): InlineMarkdownToken[] {
  const tokens: InlineMarkdownToken[] = [];
  const appendText = (text: string) => {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "text") previous.content += text;
    else tokens.push({ kind: "text", content: text });
  };

  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] === "`") {
      const close = content.indexOf("`", cursor + 1);
      if (close > cursor + 1) {
        tokens.push({ kind: "code", content: content.slice(cursor + 1, close) });
        cursor = close + 1;
        continue;
      }
    }

    if (content.startsWith("**", cursor)) {
      const close = content.indexOf("**", cursor + 2);
      if (close > cursor + 2) {
        tokens.push({ kind: "strong", content: content.slice(cursor + 2, close) });
        cursor = close + 2;
        continue;
      }
    }

    if (content[cursor] === "[") {
      const match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(content.slice(cursor));
      if (match) {
        const [source, label, href] = match;
        if (label !== undefined && href !== undefined && isSafeMarkdownHref(href)) {
          tokens.push({ kind: "link", content: label, href });
        } else {
          appendText(source);
        }
        cursor += source.length;
        continue;
      }
    }

    appendText(content[cursor]!);
    cursor += 1;
  }
  return tokens;
}

export function parseMessageBlocks(content: string): MessageBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();

  const blocks: MessageBlock[] = [];
  let pending: string[] = [];
  const flushPending = () => {
    if (pending.length === 0) return;
    const blockLines = pending;
    pending = [];
    const unordered = blockLines.map((line) => /^\s*[-*]\s+(.+)$/.exec(line));
    if (unordered.every(Boolean)) {
      blocks.push({ kind: "unordered-list", items: unordered.map((match) => match![1]!) });
      return;
    }
    const ordered = blockLines.map((line) => /^\s*\d+[.)]\s+(.+)$/.exec(line));
    if (ordered.every(Boolean)) {
      blocks.push({ kind: "ordered-list", items: ordered.map((match) => match![1]!) });
      return;
    }
    const heading = blockLines.length === 1 ? /^#{1,3}\s+(.+)$/.exec(blockLines[0]!) : null;
    blocks.push(heading
      ? { kind: "heading", content: heading[1]! }
      : { kind: "paragraph", content: blockLines.join("\n") });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = /^\s{0,3}```(?:\s*([A-Za-z0-9_+#.-]+))?\s*$/.exec(line);
    if (fence) {
      flushPending();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      blocks.push({
        kind: "code",
        content: code.join("\n"),
        ...(fence[1] ? { language: fence[1] } : {})
      });
      continue;
    }
    if (line.trim() === "") {
      flushPending();
      continue;
    }
    pending.push(line);
  }
  flushPending();
  return blocks;
}

export async function copyCodeText(content: string, clipboard?: ClipboardWriter): Promise<boolean> {
  const writer = clipboard ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
  if (!writer) return false;
  try {
    await writer.writeText(content);
    return true;
  } catch {
    return false;
  }
}

function conversationCopy(locale: AppLocale) {
  return locale === "zh-CN"
    ? { latest: "回到最新", copyCode: "复制代码", copied: "已复制", code: "代码" }
    : { latest: "Jump to latest", copyCode: "Copy code", copied: "Copied", code: "Code" };
}

/**
 * The conversation feed: messages, monitoring alerts, approval cards, the
 * live computer-use card, and on-demand insight cards in one chronological
 * stream. Item kinds are pre-merged and pre-sorted by
 * conversationTimeline.ts; this component renders them and owns the
 * near-latest scroll policy. Conversation selection still lives in the
 * sidebar; the Product Session id is used only to recognize a switch.
 */
export function ConversationFeed({ copy, locale, timeline, experiments, audit, computerMode, computerControlState, computerPermission, clientId, productSessionId, browserSessionId, browserBindingKey, guiConfigured, submitting, onFork, onRiskReview, onApprove, onCommit, onComputerControl }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  timeline: TimelineItem<ConversationMessage, Approval>[];
  experiments: Experiment[];
  audit: Audit[];
  computerMode: ComputerExecutionStatus;
  computerControlState?: string;
  computerPermission?: "disabled" | "observe" | "interactive" | "execute";
  clientId?: string;
  productSessionId?: string;
  browserSessionId?: string;
  browserBindingKey?: string;
  guiConfigured: boolean;
  submitting: boolean;
  onFork: (messageId: string) => void;
  onRiskReview: (approval: Approval) => void;
  onApprove: (approval: Approval) => void;
  onCommit: (approval: Approval) => void;
  onComputerControl: (action: ComputerControlAction) => void;
}) {
  const feedRef = useRef<HTMLElement>(null);
  const latestActionHostRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | undefined>(undefined);
  const nearLatestRef = useRef(true);
  const previousTimelineRef = useRef<{ conversationKey: string; ids: string[] } | undefined>(undefined);
  const [nearLatest, setNearLatest] = useState(true);
  const localCopy = conversationCopy(locale);
  const conversationKey = productSessionId ?? `client:${clientId ?? "unbound"}`;

  useLayoutEffect(() => {
    const feed = feedRef.current;
    const container = feed?.closest<HTMLElement>(".main-scroll");
    if (!feed || !container) return;
    scrollContainerRef.current = container;

    const syncLatestActionPosition = () => {
      latestActionHostRef.current?.style.setProperty(
        "--conversation-latest-top",
        `${Math.max(12, container.clientHeight - 44)}px`
      );
    };

    const syncLatestState = () => {
      const latest = isConversationNearLatest(container);
      nearLatestRef.current = latest;
      setNearLatest((current) => current === latest ? current : latest);
    };
    container.addEventListener("scroll", syncLatestState, { passive: true });
    window.addEventListener("resize", syncLatestActionPosition);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(syncLatestActionPosition);
    resizeObserver?.observe(container);
    syncLatestActionPosition();
    syncLatestState();

    return () => {
      container.removeEventListener("scroll", syncLatestState);
      window.removeEventListener("resize", syncLatestActionPosition);
      resizeObserver?.disconnect();
      scrollContainerRef.current = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current ?? feedRef.current?.closest<HTMLElement>(".main-scroll");
    if (!container) return;
    const ids = timeline.map((item) => item.id);
    const previous = previousTimelineRef.current;
    const update = classifyTimelineUpdate(previous?.ids ?? [], ids);
    const conversationChanged = previous !== undefined && previous.conversationKey !== conversationKey;
    if (shouldFollowConversation(update, nearLatestRef.current, conversationChanged)) {
      container.scrollTop = container.scrollHeight;
      nearLatestRef.current = true;
      setNearLatest(true);
    }
    previousTimelineRef.current = { conversationKey, ids };
  }, [conversationKey, submitting, timeline]);

  const returnToLatest = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!reducedMotion && typeof container.scrollTo === "function") {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    } else {
      container.scrollTop = container.scrollHeight;
      nearLatestRef.current = true;
      setNearLatest(true);
    }
  };

  return (
    <section ref={feedRef} className="conversation" aria-label={copy.mission}>
      <div ref={latestActionHostRef} className="conversation-latest-host">
        {!nearLatest
          ? <Button
              className="conversation-latest-button"
              variant="outline"
              size="sm"
              icon={<IconChevronDown size={13} />}
              aria-label={localCopy.latest}
              onClick={returnToLatest}
            >
              {localCopy.latest}
            </Button>
          : null}
      </div>
      {timeline.map((item) => {
        switch (item.kind) {
          case "alert":
            return <AlertCard alert={item.alert} locale={locale} copy={copy} key={item.id} />;
          case "approval":
            return <ApprovalCard approval={item.approval} locale={locale} copy={copy} onRiskReview={onRiskReview} onApprove={onApprove} onCommit={onCommit} key={item.id} />;
          case "computer":
            return <ComputerUseCard
              copy={copy}
              locale={locale}
              mode={computerMode}
              {...(computerControlState ? { controlState: computerControlState } : {})}
              {...(computerPermission ? { computerPermission } : {})}
              computer={item.computer}
              guiConfigured={guiConfigured}
              {...(clientId ? { clientId } : {})}
              {...(productSessionId ? { productSessionId } : {})}
              {...(browserSessionId ? { browserSessionId } : {})}
              {...(browserBindingKey ? { browserBindingKey } : {})}
              onControl={onComputerControl}
              key={item.id}
            />;
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
        <MessageBody content={message.content} locale={locale} />
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

export function MessageBody({ content, locale }: { content: string; locale: AppLocale }) {
  const blocks = parseMessageBlocks(content);
  return (
    <div className="message-body">
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return <CodeBlock
            content={block.content}
            {...(block.language ? { language: block.language } : {})}
            locale={locale}
            key={index}
          />;
        }
        if (block.kind === "unordered-list") {
          return <ul key={index}>{block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}><InlineMarkdown content={item} /></li>)}</ul>;
        }
        if (block.kind === "ordered-list") {
          return <ol key={index}>{block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}><InlineMarkdown content={item} /></li>)}</ol>;
        }
        if (block.kind === "heading") return <h4 key={index}><InlineMarkdown content={block.content} /></h4>;
        return <p key={index}><InlineMarkdown content={block.content} /></p>;
      })}
    </div>
  );
}

function InlineMarkdown({ content }: { content: string }) {
  return parseInlineMarkdown(content).map((token, index): ReactNode => {
    if (token.kind === "strong") return <strong key={index}>{token.content}</strong>;
    if (token.kind === "code") return <code key={index}>{token.content}</code>;
    if (token.kind === "link") {
      const opensWindow = /^https?:/i.test(token.href);
      return (
        <a
          href={token.href}
          {...(opensWindow ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          key={index}
        >
          {token.content}
        </a>
      );
    }
    return token.content;
  });
}

function CodeBlock({ content, language, locale }: { content: string; language?: string; locale: AppLocale }) {
  const copy = conversationCopy(locale);
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimerRef.current !== undefined) clearTimeout(resetTimerRef.current);
  }, []);

  const copyCode = async () => {
    if (!await copyCodeText(content)) return;
    setCopied(true);
    if (resetTimerRef.current !== undefined) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 1_800);
  };

  return (
    <div className="message-code-block">
      <div className="message-code-head">
        <span>{language ?? copy.code}</span>
        <Button
          variant="subtle"
          size="sm"
          aria-live="polite"
          aria-label={copied ? copy.copied : copy.copyCode}
          onClick={() => void copyCode()}
        >
          {copied ? copy.copied : copy.copyCode}
        </Button>
      </div>
      <pre><code>{content}</code></pre>
    </div>
  );
}
