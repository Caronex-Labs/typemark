/**
 * Agent bridge (page side). Connects a live editor to a local agent over a
 * WebSocket, e.g. the typemark MCP server shipped with the Claude Code plugin,
 * so a coding agent can act as the reviewer: read the document, suggest edits,
 * add notes, reply in threads, resolve @ai instructions, and get told when the
 * writer finishes a block.
 *
 *   import { connectAgent } from "typemark";
 *   const agent = connectAgent(editor);            // ws://127.0.0.1:4799 by default
 *
 * Agents anchor by QUOTING text (robust for language models); quotes are
 * resolved to markdown offsets here, in the page.
 */
import type { InstructionJob, Thread } from "./ai";
import type { Editor } from "./editor";

export const BRIDGE_PROTOCOL = 1;

export interface AgentBridgeOptions {
  /** Default ws://127.0.0.1:4799 */
  url?: string;
  /** Stable id for this document (default: location.pathname). */
  docId?: string;
  /** Shown to the agent (default: document title / first heading). */
  title?: string;
  /** Author name used for the agent's edits and notes (default "Claude"). */
  author?: string;
  /** Called when the connection state changes. */
  onStatus?(status: "connecting" | "connected" | "disconnected"): void;
  /** Reconnect delay in ms (default 2000; 0 disables). */
  retryMs?: number;
}

export interface AgentBridge {
  readonly status: "connecting" | "connected" | "disconnected";
  disconnect(): void;
}

type Req = { t: "req"; id: number; method: string; params: Record<string, unknown> };

/** Resolve a quoted snippet to markdown offsets. */
export function resolveQuote(md: string, quote: string, occurrence?: number): { from: number; to: number } {
  if (!quote) throw new Error("quote is empty");
  const hits: number[] = [];
  for (let i = md.indexOf(quote); i >= 0; i = md.indexOf(quote, i + 1)) hits.push(i);
  if (!hits.length) {
    // tolerate whitespace differences
    const re = new RegExp(quote.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "g");
    for (let m = re.exec(md); m; m = re.exec(md)) hits.push(m.index), (quote = m[0]);
    if (!hits.length) throw new Error(`quote not found in the document: ${JSON.stringify(quote.slice(0, 80))}`);
  }
  if (hits.length > 1 && !occurrence)
    throw new Error(`quote appears ${hits.length} times; pass occurrence (1-${hits.length}) or quote more text`);
  const at = hits[(occurrence ?? 1) - 1];
  if (at === undefined) throw new Error(`occurrence ${occurrence} out of range (1-${hits.length})`);
  return { from: at, to: at + quote.length };
}

function threadJson(t: Thread | null) {
  if (!t) return null;
  return {
    id: t.id,
    unit: { id: t.unit.id, markdown: t.unit.markdown },
    history: t.history.map((e) => ({ type: e.type, author: e.author, text: e.text })),
    open: {
      suggestions: t.open.suggestions.map((s) => ({ id: s.id, original: s.original, replacement: s.text, author: s.author, reason: s.reason })),
      notes: t.open.notes.map((n) => ({ id: n.id, kind: n.kind, author: n.author, body: n.body, replies: n.replies ?? [] })),
      comments: t.open.comments.map((c) => ({ id: c.id, quote: c.quote, data: c.data })),
      marks: t.open.marks.map((m) => ({ id: m.id, severity: m.severity, message: m.message, source: m.source })),
    },
  };
}

export function connectAgent(editor: Editor, o: AgentBridgeOptions = {}): AgentBridge {
  const url = o.url ?? "ws://127.0.0.1:4799";
  const author = o.author ?? "Claude";
  const ai = editor.ai;
  const jobs = new Map<string, InstructionJob>();
  let ws: WebSocket | null = null;
  let status: AgentBridge["status"] = "disconnected";
  let closed = false;
  let timer = 0;

  const setStatus = (s: AgentBridge["status"]) => {
    status = s;
    o.onStatus?.(s);
  };
  const send = (msg: unknown) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const title = () => o.title ?? editor.getMetadata().title ?? document.title;
  const unitOf = (from: number) => ai.unitAt(from);

  const methods: Record<string, (p: Record<string, any>) => unknown> = {
    read: () => {
      const meta = editor.getMetadata();
      return {
        title: title(),
        markdown: editor.getMarkdown(),
        headings: meta.headings.map((h) => ({ level: h.level, text: h.text })),
        tasks: meta.taskSummary,
        dirtyUnits: ai.getDirtyUnits().map((u) => ({ id: u.id, markdown: u.markdown })),
        threads: ai.getThreads().map(threadJson),
        selection: (() => {
          const s = editor.getSelectionOffsets();
          return s ? { text: editor.getMarkdown().slice(s.from, s.to), from: s.from, to: s.to } : null;
        })(),
      };
    },
    getThread: (p) => {
      const at = p.unitId ?? resolveQuote(editor.getMarkdown(), p.quote, p.occurrence).from;
      return threadJson(ai.getThread(at));
    },
    suggestEdit: (p) => {
      const r = resolveQuote(editor.getMarkdown(), p.quote, p.occurrence);
      const hs = ai.suggestEdit(r.from, r.to, String(p.replacement ?? ""), { author: p.author ?? author, reason: p.reason, granular: p.granular !== false });
      return { suggestionIds: hs.map((h) => h.id), thread: threadJson(ai.getThread(r.from)) };
    },
    suggestBlocks: (p) => {
      const md = editor.getMarkdown();
      const after = p.afterQuote ? resolveQuote(md, p.afterQuote, p.occurrence).to : md.length;
      const h = ai.suggestBlocks(after, String(p.markdown ?? ""), { author: p.author ?? author, reason: p.reason });
      return { suggestionId: h.id };
    },
    addNote: (p) => {
      const r = resolveQuote(editor.getMarkdown(), p.quote, p.occurrence);
      const id = ai.addNote({ from: r.from, to: r.to, kind: p.kind ?? "question", body: String(p.body ?? ""), title: p.title, author: p.author ?? author, replyPlaceholder: "Reply to " + (p.author ?? author) + "…" });
      return { noteId: id, thread: threadJson(ai.getThread(r.from)) };
    },
    reply: (p) => {
      const note = p.noteId ? ai.getNotes().find((n) => n.id === p.noteId) : null;
      const at = note?.from ?? (p.unitId ? ai.unitAt(p.unitId)?.from : resolveQuote(editor.getMarkdown(), p.quote, p.occurrence).from);
      if (at === undefined) throw new Error("no such note / unit");
      const target = note ?? ai.getThread(at)?.open.notes.slice(-1)[0];
      if (target) ai.addReply(target.id, { author: p.author ?? author, body: String(p.body ?? "") });
      else return { noteId: ai.addNote({ from: at, to: at, kind: "info", body: String(p.body ?? ""), author: p.author ?? author }) };
      return { noteId: target.id };
    },
    addComment: (p) => {
      const r = resolveQuote(editor.getMarkdown(), p.quote, p.occurrence);
      return { commentId: ai.addComment({ from: r.from, to: r.to, data: { text: p.text, author: p.author ?? author } }) };
    },
    setMarks: (p) => {
      const md = editor.getMarkdown();
      const marks = (p.marks as any[]).map((m) => {
        const r = resolveQuote(md, m.quote, m.occurrence);
        return { ...r, severity: m.severity ?? "info", message: String(m.message ?? ""), fixes: m.fix !== undefined ? [{ label: m.fixLabel ?? "Apply", text: String(m.fix) }] : [] };
      });
      ai.setMarks(String(p.source ?? author), marks);
      return { count: marks.length };
    },
    resolveInstruction: (p) => {
      const job = jobs.get(p.jobId);
      if (!job) throw new Error("unknown or finished instruction job: " + p.jobId);
      if (p.fail) job.fail(String(p.fail));
      else if (p.question)
        job.ask(String(p.question), (answer) => send({ t: "event", event: { type: "instruction_answer", jobId: job.id, answer } }));
      else {
        job.resolve(String(p.markdown ?? ""), { reason: p.reason });
        jobs.delete(job.id);
      }
      return { status: job.status };
    },
    markReviewed: (p) => {
      ai.markReviewed(p.unitId);
      return { ok: true };
    },
  };

  const offs = [
    ai.on("settled", (unit, { reason, thread }) =>
      send({ t: "event", event: { type: "settled", reason, unit: { id: unit.id, markdown: unit.markdown }, thread: threadJson(thread) } }),
    ),
    ai.on("reply", (thread, text) => send({ t: "event", event: { type: "reply", text, thread: threadJson(thread) } })),
    ai.on("instruction", (job) => {
      jobs.set(job.id, job);
      send({
        t: "event",
        event: {
          type: "instruction",
          jobId: job.id,
          agent: job.agent,
          instruction: job.instruction,
          context: { before: job.context.before.slice(-1500), after: job.context.after.slice(0, 800), headingPath: job.context.headingPath },
          unit: unitOf(job.from) ? { id: unitOf(job.from)!.id, markdown: unitOf(job.from)!.markdown } : null,
          thread: threadJson(job.thread),
        },
      });
    }),
  ];

  const open = () => {
    if (closed) return;
    setStatus("connecting");
    try {
      ws = new WebSocket(url);
    } catch {
      return retry();
    }
    ws.onopen = () => {
      setStatus("connected");
      send({ t: "hello", v: BRIDGE_PROTOCOL, doc: { id: o.docId ?? location.pathname, title: title(), url: location.href } });
    };
    ws.onmessage = async (ev) => {
      let msg: Req;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t !== "req") return;
      try {
        const fn = methods[msg.method];
        if (!fn) throw new Error(`unknown method ${msg.method}`);
        send({ t: "res", id: msg.id, ok: true, result: await fn(msg.params ?? {}) });
      } catch (e) {
        send({ t: "res", id: msg.id, ok: false, error: String((e as Error)?.message ?? e) });
      }
    };
    ws.onclose = () => {
      ws = null;
      setStatus("disconnected");
      retry();
    };
    ws.onerror = () => ws?.close();
  };
  const retry = () => {
    const ms = o.retryMs ?? 2000;
    if (!closed && ms > 0) timer = window.setTimeout(open, ms);
  };
  open();

  return {
    get status() {
      return status;
    },
    disconnect() {
      closed = true;
      clearTimeout(timer);
      offs.forEach((f) => f());
      ws?.close();
    },
  };
}
