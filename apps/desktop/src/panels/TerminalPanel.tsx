import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceCopy, type AppLocale } from "../labels.js";
import {
  fsTreeUrl,
  interpolate,
  localTerminalChunk,
  mergeTerminalChunks,
  serverLastSeq,
  terminalActionUrl,
  terminalOutputUrl,
  terminalUrl,
  type CommandClassification,
  type FsTreeResponse,
  type TerminalChunk,
  type TerminalSessionInfo
} from "../workspace.js";
import { Button, Tooltip } from "../ui.js";
import { IconDismiss, IconPlus, IconStop } from "../icons.js";

const POLL_INTERVAL_MS = 800;

type ExecResult = { exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean };

/**
 * Terminal panel: real interactive shell sessions over /api/terminals.
 * Sessions are created on demand (default cwd = project root, or the
 * resolved home directory), output is incrementally polled every 800ms by
 * seq, input is written to the shell stdin, and the exec toggle runs one-shot
 * classified commands — a 409 COMMAND_APPROVAL_REQUIRED surfaces the
 * classifier verdict with an explicit "run anyway" resend. Sessions the panel
 * created are killed when it unmounts so the server's 8-session cap is never
 * leaked.
 */
export function TerminalPanel({ locale, defaultCwd, projectName }: {
  locale: AppLocale;
  /** Project's first rootPath; empty string falls back to the home directory. */
  defaultCwd: string;
  projectName: string;
}) {
  const copy = workspaceCopy(locale);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chunksBySession, setChunksBySession] = useState<Record<string, TerminalChunk[]>>({});
  const [exited, setExited] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [execMode, setExecMode] = useState(false);
  const [execBusy, setExecBusy] = useState(false);
  const [approval, setApproval] = useState<{ command: string; classification: CommandClassification } | null>(null);
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(true);

  const sessionsRef = useRef<TerminalSessionInfo[]>([]);
  const chunksRef = useRef<Record<string, TerminalChunk[]>>({});
  const haltedRef = useRef<Set<string>>(new Set());
  const localSeqRef = useRef(0);
  const outputRef = useRef<HTMLDivElement | null>(null);

  sessionsRef.current = sessions;
  chunksRef.current = chunksBySession;

  const appendLocal = useCallback((sessionId: string, data: string, stream: TerminalChunk["stream"] = "meta") => {
    localSeqRef.current += 1;
    setChunksBySession((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), localTerminalChunk(localSeqRef.current, data, stream)]
    }));
  }, []);

  const createSession = useCallback(async () => {
    let cwd = defaultCwd;
    if (!cwd) {
      try {
        const response = await fetch(fsTreeUrl("~", 0));
        if (response.ok) cwd = ((await response.json()) as FsTreeResponse).root;
      } catch { /* fall through to the server's error, surfaced below */ }
    }
    if (!cwd) throw new Error(copy.terminalCreateFailed);
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, title: projectName })
    });
    const body = await response.json().catch(() => undefined) as (TerminalSessionInfo & { error?: string }) | undefined;
    if (!response.ok || !body?.id) throw new Error(body?.error ?? copy.terminalCreateFailed);
    setSessions((current) => [...current, body]);
    setActiveId(body.id);
    return body;
  }, [copy, defaultCwd, projectName]);

  /* Boot the first session; kill every panel-owned session on unmount. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await createSession();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : copy.terminalCreateFailed);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
      for (const session of sessionsRef.current) {
        void fetch(terminalUrl(session.id), { method: "DELETE" }).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Incremental output polling for every live session. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const session of sessionsRef.current) {
        if (haltedRef.current.has(session.id)) continue;
        void (async () => {
          try {
            const since = serverLastSeq(chunksRef.current[session.id] ?? []);
            const response = await fetch(terminalOutputUrl(session.id, since));
            if (!response.ok) {
              haltedRef.current.add(session.id);
              return;
            }
            const body = await response.json() as { chunks: TerminalChunk[]; running: boolean };
            if (body.chunks.length > 0) {
              setChunksBySession((current) => ({
                ...current,
                [session.id]: mergeTerminalChunks(current[session.id] ?? [], body.chunks)
              }));
            }
            if (!body.running) {
              haltedRef.current.add(session.id);
              setExited((current) => ({ ...current, [session.id]: true }));
            }
          } catch { /* transient network failure — the next tick retries */ }
        })();
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  /* Keep the output pinned to the bottom as chunks stream in. */
  const activeChunks = activeId ? chunksBySession[activeId] ?? [] : [];
  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeChunks.length, activeId]);

  async function sendInput() {
    if (!activeId || !input) return;
    const data = input.endsWith("\n") ? input : `${input}\n`;
    setInput("");
    try {
      await fetch(terminalActionUrl(activeId, "input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data })
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function runExec(command: string, approved = false) {
    if (!activeId || !command.trim() || execBusy) return;
    setExecBusy(true);
    setError("");
    const sessionId = activeId;
    appendLocal(sessionId, `$ ${command}`);
    try {
      const response = await fetch(terminalActionUrl(sessionId, "exec"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, ...(approved ? { approved: true } : {}) })
      });
      const body = await response.json().catch(() => undefined) as (ExecResult & { error?: string; code?: string; classification?: CommandClassification | null }) | undefined;
      if (response.status === 409 && body?.code === "COMMAND_APPROVAL_REQUIRED") {
        setApproval({ command, classification: body.classification ?? { verdict: "unknown", reason: body.error ?? "" } });
        return;
      }
      if (!response.ok || !body) throw new Error(body?.error ?? String(response.status));
      if (body.stdout) appendLocal(sessionId, body.stdout.replace(/\n$/, ""), "stdout");
      if (body.stderr) appendLocal(sessionId, body.stderr.replace(/\n$/, ""), "stderr");
      appendLocal(sessionId, `${interpolate(copy.terminalExitCode, { code: String(body.exitCode ?? "—") })} · ${body.durationMs}ms${body.timedOut ? " · timeout" : ""}`);
      setApproval(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecBusy(false);
    }
  }

  async function interrupt() {
    if (!activeId) return;
    await fetch(terminalActionUrl(activeId, "interrupt"), { method: "POST" }).catch(() => undefined);
  }

  async function closeSession(id: string) {
    haltedRef.current.add(id);
    await fetch(terminalUrl(id), { method: "DELETE" }).catch(() => undefined);
    setSessions((current) => {
      const next = current.filter((session) => session.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }

  const activeExited = activeId ? exited[activeId] === true : false;

  return (
    <div className="panel terminal-panel">
      <div className="term-tabs" role="tablist">
        {sessions.map((session, index) => (
          <span key={session.id} className={`term-tab${session.id === activeId ? " active" : ""}`}>
            <button type="button" role="tab" aria-selected={session.id === activeId} onClick={() => setActiveId(session.id)}>
              {session.title || `${copy.tabTerminal} ${index + 1}`}
            </button>
            <Tooltip content={copy.terminalCloseTab} side="bottom">
              <button type="button" className="term-tab-close" aria-label={copy.terminalCloseTab} onClick={() => void closeSession(session.id)}>
                <IconDismiss size={10} />
              </button>
            </Tooltip>
          </span>
        ))}
        <Tooltip content={copy.terminalNew} side="bottom">
          <button type="button" className="term-tab-new" aria-label={copy.terminalNew} onClick={() => void createSession().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>
            <IconPlus size={12} />
          </button>
        </Tooltip>
      </div>

      {error && (
        <div className="panel-banner" data-tone="danger" role="alert">
          <span>{error}</span>
          <button type="button" aria-label={copy.close} onClick={() => setError("")}><IconDismiss size={11} /></button>
        </div>
      )}
      {approval && (
        <div className="panel-banner" data-tone="warning" role="alertdialog" aria-label={copy.terminalApprovalTitle}>
          <div>
            <strong>{copy.terminalApprovalTitle}</strong>
            <p>{interpolate(copy.terminalApprovalBody, { verdict: approval.classification.verdict, reason: approval.classification.reason })}</p>
          </div>
          <div className="panel-banner-actions">
            <Button size="sm" variant="subtle" onClick={() => setApproval(null)}>{copy.cancel}</Button>
            <Button size="sm" variant="outline" disabled={execBusy} onClick={() => void runExec(approval.command, true)}>{copy.terminalRunAnyway}</Button>
          </div>
        </div>
      )}

      <div className="term-output" ref={outputRef} aria-live="polite">
        {booting && <div className="term-line" data-stream="meta">{copy.terminalStarting}</div>}
        {activeChunks.map((chunk) => (
          <div key={chunk.seq} className="term-line" data-stream={chunk.stream}>{chunk.data}</div>
        ))}
        {activeExited && <div className="term-line" data-stream="meta">{copy.terminalExited}</div>}
      </div>

      <div className="term-input-row">
        <button
          type="button"
          className={`term-exec-toggle${execMode ? " active" : ""}`}
          aria-pressed={execMode}
          onClick={() => setExecMode((mode) => !mode)}
        >
          {copy.terminalExecLabel}
        </button>
        <input
          value={input}
          placeholder={execMode ? copy.terminalExecPlaceholder : copy.terminalPlaceholder}
          aria-label={execMode ? copy.terminalExecPlaceholder : copy.terminalPlaceholder}
          disabled={!activeId || activeExited}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (execMode) {
              const command = input;
              setInput("");
              void runExec(command);
            } else {
              void sendInput();
            }
          }}
        />
        {execMode ? (
          <Button size="sm" variant="primary" disabled={!activeId || execBusy || !input.trim()} onClick={() => { const command = input; setInput(""); void runExec(command); }}>
            {copy.terminalExecRun}
          </Button>
        ) : (
          <Tooltip content={copy.terminalInterrupt} side="top">
            <Button size="sm" variant="subtle" className="icon-button" icon={<IconStop size={13} />} aria-label={copy.terminalInterrupt} disabled={!activeId || activeExited} onClick={() => void interrupt()} />
          </Tooltip>
        )}
      </div>
    </div>
  );
}
