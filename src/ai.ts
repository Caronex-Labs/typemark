/**
 * Review layer for AI (or human) collaborators working ON TOP of written text.
 * No model is integrated: the host app runs its agents and drives this API.
 *
 *   suggestions  Google-Docs-style suggested edits: struck original + inserted
 *                replacement, accept / reject, word-level diff, streaming.
 *                Block-sized proposals render as phantom blocks.
 *   notes        Phantom blocks anchored to a span: an agent's question, issue
 *                or remark, with host-defined actions and an optional reply box.
 *   comments     Anchored highlights for the host's own comment threads.
 *   marks        Review squiggles (error / warning / info / style) with fixes.
 *   provenance   Optional tint on text that came from accepted suggestions.
 *
 * Nothing here enters the markdown until a suggestion is accepted (one undo
 * step). All anchors are markdown offsets and follow every edit.
 */
import { parse, renderBlock } from "./block";
import type { DocChange, Editor } from "./editor";
import { renderInline } from "./inline";
import { INSTRUCTION as INSTRUCTION_RE } from "./extensions";

// ------------------------------------------------------------------ types

export type SuggestionDisplay = "inline" | "block";

export interface Suggestion {
  id: string;
  /** Markdown range being replaced (from === to: pure insertion). */
  from: number;
  to: number;
  /** Replacement markdown. */
  text: string;
  /** The text the suggestion was made against (stale if the document no longer has it there). */
  original: string;
  display: SuggestionDisplay;
  status: "streaming" | "ready";
  /** Suggestions from one suggestEdit() call share a group. */
  group?: string;
  author?: string;
  /** Short reason shown in the review card ("Matches the code: timeout is 30s"). */
  reason?: string;
  data?: unknown;
}

export interface SuggestionHandle {
  readonly id: string;
  get(): Suggestion | undefined;
  /** Streaming: add text as the model produces it. */
  append(chunk: string): void;
  setText(text: string): void;
  /** Streaming finished. */
  finish(): void;
  accept(): void;
  reject(): void;
}

export type NoteKind = "question" | "issue" | "info" | "success";

export interface NoteAction {
  label: string;
  /** Visual weight. */
  primary?: boolean;
  run(note: Note, ctx: { review: AIReview; editor: Editor }): void | Promise<void>;
}

export interface Note {
  id: string;
  from: number;
  to: number;
  kind: NoteKind;
  /** Markdown body (rendered with the editor's renderer). */
  body: string;
  title?: string;
  author?: string;
  actions?: NoteAction[];
  /** Show a reply box; replies go to onReply (the host forwards them to its agent). */
  replyPlaceholder?: string;
  onReply?(text: string, note: Note): void | Promise<void>;
  /** Thread so far (rendered under the body). */
  replies?: { author: string; body: string }[];
  status: "streaming" | "ready";
  /** The span this note was anchored to no longer exists (text deleted). */
  detached?: boolean;
  data?: unknown;
}

export interface Comment {
  id: string;
  from: number;
  to: number;
  quote: string;
  resolved?: boolean;
  data?: unknown;
}

export type MarkSeverity = "error" | "warning" | "info" | "style";

export interface Mark {
  id: string;
  from: number;
  to: number;
  severity: MarkSeverity;
  message: string;
  source: string;
  fixes?: { label: string; text: string }[];
  data?: unknown;
}

export interface InstructionJob {
  id: string;
  /** Agent name from `@ai(name)`, "ai" by default. */
  agent: string;
  /** The instruction text (without the `@ai` prefix). */
  instruction: string;
  /** Current markdown range of the instruction block. */
  readonly from: number;
  readonly to: number;
  status: "running" | "done" | "error";
  /** Prompt context: text before/after, heading path. */
  context: ReturnType<AIReview["getContext"]>;
  /** What already happened on this unit (other agents' suggestions and notes). */
  thread: Thread | null;
  /** Replace the instruction with this markdown (as a suggestion, or applied when autoApply). */
  resolve(markdown: string, o?: { reason?: string }): void;
  /** Stream the replacement: returns a suggestion handle; call finish() at the end. */
  stream(o?: { reason?: string }): SuggestionHandle;
  /** Mark failed; the message is shown on the instruction block. */
  fail(message: string): void;
  /** Ask the writer something before continuing (renders a question note on the instruction). */
  ask(question: string, onAnswer: (answer: string) => void | Promise<void>): void;
}

/**
 * A review unit: one block, or a tight run of blocks that belong together
 * (list items incl. nested ones, consecutive quote lines). Every unit has
 * at most ONE thread.
 */
export interface Unit {
  /** Id of the unit's first block. */
  id: string;
  from: number;
  to: number;
  markdown: string;
  blockIds: string[];
}

export type ThreadEventType = "suggestion" | "note" | "comment" | "mark" | "reply" | "accepted" | "rejected" | "stale" | "dismissed";

export interface ThreadEvent {
  type: ThreadEventType;
  author?: string;
  /** Human-readable summary ("\"3\" → \"5\"", the note body, the reply...). */
  text: string;
  itemId?: string;
  time: number;
}

/** Everything that happened on one unit: what is open now and the full history. */
export interface Thread {
  id: string;
  unit: Unit;
  open: { suggestions: Suggestion[]; notes: Note[]; comments: Comment[]; marks: Mark[] };
  history: ThreadEvent[];
}

export interface AIReviewOptions {
  /**
   * The writer finished with a unit they edited: they moved the caret to another unit
   * ("left") or paused for settleMs ("idle"). Use it to schedule per-block reviews.
   */
  onUnitSettled?(unit: Unit, ctx: { reason: "left" | "idle"; thread: Thread | null; review: AIReview }): void;
  /** Pause (ms) after which an edited unit counts as settled (default 2500; 0 = only on leave). */
  settleMs?: number;
  /** A reply typed in a thread card (the host forwards it to its agent). Falls back to the latest note's onReply. */
  onThreadReply?(thread: Thread, text: string): void | Promise<void>;
  /**
   * An `@ai …` instruction was run (Enter at its end, or runInstructions()).
   * Hand it to your agent and call job.resolve / job.stream / job.fail / job.ask.
   */
  onInstruction?(job: InstructionJob): void | Promise<void>;
  /** Apply instruction results directly instead of proposing them (default false). */
  autoApplyInstructions?: boolean;
  onAccept?(s: Suggestion): void;
  onReject?(s: Suggestion): void;
  /** The text a suggestion targeted changed underneath it; it was removed. */
  onStale?(s: Suggestion): void;
  onCommentClick?(c: Comment, ev: MouseEvent): void;
  onNoteDismiss?(n: Note): void;
  /** Tint text that came from accepted suggestions (default false). */
  markAccepted?: boolean;
  /** Built-in review card for suggestions and marks (default true). */
  card?: boolean;
}

// ------------------------------------------------------------------ helpers

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const hasHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** Map an offset through a change. assoc>0: an insertion exactly here pushes it right. */
export function mapOffset(o: number, ch: DocChange, assoc: -1 | 1): number {
  if (o < ch.from) return o;
  if (o > ch.oldTo) return o + (ch.newTo - ch.oldTo);
  if (ch.from === ch.oldTo) return assoc > 0 ? ch.newTo : o;
  if (o === ch.from) return ch.from;
  if (o === ch.oldTo) return ch.newTo;
  return assoc > 0 ? ch.newTo : ch.from;
}

/** Render markdown (several blocks) as static HTML using the editor's renderer. */
export function renderMarkdown(md: string): string {
  return parse(md)
    .map((b) => {
      const r = renderBlock(b.src);
      return `<${r.tag} class="md-block md-${r.type}"${r.attrs}>${r.html || "<br>"}</${r.tag}>`;
    })
    .join("");
}

/** Word-level diff of a -> b as replacement hunks (offsets into a). */
export function diffWords(a: string, b: string): { from: number; to: number; text: string }[] {
  const tok = (s: string) => s.match(/\s+|\w+|[^\s\w]/g) ?? [];
  const A = tok(a);
  const B = tok(b);
  if (A.length * B.length > 250_000) return a === b ? [] : [{ from: 0, to: a.length, text: b }];
  // LCS table (suffix lengths)
  const L: Uint16Array[] = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks: { from: number; to: number; text: string }[] = [];
  let i = 0;
  let j = 0;
  let pos = 0;
  let cur: { from: number; to: number; text: string } | null = null;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      flush();
      pos += A[i].length;
      i++;
      j++;
    } else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) {
      cur ??= { from: pos, to: pos, text: "" };
      cur.text += B[j++];
    } else {
      cur ??= { from: pos, to: pos, text: "" };
      pos += A[i].length;
      cur.to = pos;
      i++;
    }
  }
  flush();
  // merge hunks separated by a single whitespace token: "the big" -> "a small" reads as one change
  const merged: typeof hunks = [];
  for (const h of hunks) {
    const prev = merged[merged.length - 1];
    if (prev && /^\s*$/.test(a.slice(prev.to, h.from)) && h.from - prev.to <= 1) {
      prev.text += a.slice(prev.to, h.from) + h.text;
      prev.to = h.to;
    } else merged.push({ ...h });
  }
  return merged;
}

// ------------------------------------------------------------------ the layer

/** A thread is keyed to the unit's first BLOCK ID (stable across edits); the offset is only a fallback. */
type ThreadRec = { id: string; blockId: string; anchor: number; history: ThreadEvent[] };

export class AIReview {
  private suggestions = new Map<string, Suggestion>();
  private notes = new Map<string, Note>();
  private comments = new Map<string, Comment>();
  private marks = new Map<string, Mark>();
  private authored: { from: number; to: number }[] = [];
  private activeComment: string | null = null;
  private activeSuggestion: string | null = null;
  private card: HTMLDivElement | null = null;
  private applying = false;
  private unsub: (() => void)[] = [];
  private replyDrafts = new Map<string, string>();
  private noteEvents = new Map<string, ThreadEvent>();
  private knownMd = "";
  private threads = new Map<string, ThreadRec>();
  private dirty = new Set<number>();
  private settleTimer = 0;
  private caretUnit: string | null = null;
  private openHistory = new Set<string>();
  private jobs = new Map<string, { id: string; from: number; to: number; status: InstructionJob["status"]; error?: string; agent: string }>();

  constructor(
    readonly editor: Editor,
    private opts: AIReviewOptions = {},
  ) {
    this.unsub.push(
      editor.onDocChange((c) => this.map(c)),
      // the editor redraws BEFORE it reports the change: only draw once anchors are mapped
      editor.onRender(() => editor.getMarkdown() === this.knownMd && this.render()),
      editor.onKey((e) => this.key(e)),
      editor.onPointer((e, off) => this.pointer(e, off)),
    );
    document.addEventListener("scroll", this.hideCard, true);
    document.addEventListener("selectionchange", this.onSelection);
    this.knownMd = editor.getMarkdown();
  }

  destroy(): void {
    this.unsub.forEach((u) => u());
    document.removeEventListener("scroll", this.hideCard, true);
    document.removeEventListener("selectionchange", this.onSelection);
    clearTimeout(this.settleTimer);
    this.card?.remove();
    this.clearDom();
    if (hasHighlights()) for (const n of HIGHLIGHTS) CSS.highlights.delete(n);
  }

  // ---------------------------------------------------------------- units + threads

  /** Review units of the document (blocks, with tight runs grouped). */
  getUnits(): Unit[] {
    const lay = this.editor.docLayout();
    const blocks = this.editor.getBlocks();
    const md = this.editor.getMarkdown();
    const units: Unit[] = [];
    blocks.forEach((b, i) => {
      const l = lay[i];
      const prev = units[units.length - 1];
      const tight = i > 0 && l.start - lay[i - 1].end === 1; // "\n" separator = same list / quote run
      if (prev && tight) {
        prev.to = l.end;
        prev.blockIds.push(b.id);
      } else units.push({ id: b.id, from: l.start, to: l.end, markdown: "", blockIds: [b.id] });
    });
    for (const u of units) u.markdown = md.slice(u.from, u.to);
    return units;
  }

  /** The unit containing a markdown offset (a block id is accepted too). */
  unitAt(offsetOrBlockId: number | string): Unit | null {
    const units = this.getUnits();
    if (typeof offsetOrBlockId === "string") return units.find((u) => u.blockIds.includes(offsetOrBlockId)) ?? null;
    return units.find((u) => u.from <= offsetOrBlockId && offsetOrBlockId <= u.to) ?? units.find((u) => offsetOrBlockId < u.from) ?? units[units.length - 1] ?? null;
  }

  /** The single thread for a unit (merging threads whose units were merged). Created on demand when `create`. */
  private threadFor(unit: Unit, create: boolean): ThreadRec | null {
    const ids = new Set(this.editor.getBlocks().map((b) => b.id));
    const mine = [...this.threads.values()].filter((t) =>
      ids.has(t.blockId) ? unit.blockIds.includes(t.blockId) : unit.from <= t.anchor && t.anchor <= unit.to,
    );
    if (mine.length > 1) {
      const [keep, ...rest] = mine;
      for (const t of rest) {
        keep.history.push(...t.history);
        this.threads.delete(t.id);
      }
      keep.history.sort((a, b) => a.time - b.time);
    }
    if (mine[0]) {
      mine[0].blockId = unit.id;
      mine[0].anchor = unit.from;
      return mine[0];
    }
    if (!create) return null;
    const t: ThreadRec = { id: uid("t"), blockId: unit.id, anchor: unit.from, history: [] };
    this.threads.set(t.id, t);
    return t;
  }

  private log(at: number, ev: Omit<ThreadEvent, "time">): ThreadEvent | null {
    const unit = this.unitAt(at);
    if (!unit) return null;
    const e = { ...ev, time: Date.now() };
    this.threadFor(unit, true)!.history.push(e);
    return e;
  }

  /** The thread of the unit containing `at` (offset or block id), or null when nothing happened there. */
  getThread(at: number | string): Thread | null {
    const unit = this.unitAt(at);
    if (!unit) return null;
    const t = this.threadFor(unit, false);
    if (!t) return null;
    const inUnit = (x: { from: number }) => unit.from <= x.from && x.from <= unit.to;
    return {
      id: t.id,
      unit,
      history: t.history.slice(),
      open: {
        suggestions: this.getSuggestions().filter(inUnit),
        notes: this.getNotes().filter(inUnit),
        comments: this.getComments().filter(inUnit),
        marks: this.getMarks().filter(inUnit),
      },
    };
  }

  getThreads(): Thread[] {
    return this.getUnits()
      .map((u) => this.getThread(u.id))
      .filter((t): t is Thread => !!t);
  }

  // ---------------------------------------------------------------- cadence

  /** Units edited by the writer since they were last reviewed. */
  getDirtyUnits(): Unit[] {
    const seen = new Set<string>();
    const out: Unit[] = [];
    for (const off of this.dirty) {
      const u = this.unitAt(off);
      if (u && !seen.has(u.id)) seen.add(u.id), out.push(u);
    }
    return out;
  }

  /** Mark a unit (offset / block id / Unit) as reviewed: it leaves getDirtyUnits(). */
  markReviewed(at: number | string | Unit): void {
    const u = typeof at === "object" ? at : this.unitAt(at);
    if (!u) return;
    for (const off of [...this.dirty]) if (u.from <= off && off <= u.to) this.dirty.delete(off);
  }

  private settle(unitId: string, reason: "left" | "idle"): void {
    const u = this.getDirtyUnits().find((x) => x.id === unitId);
    if (!u) return;
    this.markReviewed(u);
    this.opts.onUnitSettled?.(u, { reason, thread: this.getThread(u.id), review: this });
  }

  private onSelection = (): void => {
    const sel = this.editor.getSelectionOffsets();
    const u = sel ? this.unitAt(sel.from) : null;
    const prev = this.caretUnit;
    this.caretUnit = u?.id ?? null;
    if (prev && prev !== this.caretUnit) this.settle(prev, "left");
  };

  // ---------------------------------------------------------------- suggestions

  /** Propose replacing [from, to) with `text`. Use streaming: true and append() for live output. */
  suggest(input: {
    from: number;
    to?: number;
    text?: string;
    display?: SuggestionDisplay;
    reason?: string;
    author?: string;
    group?: string;
    data?: unknown;
    id?: string;
    streaming?: boolean;
  }): SuggestionHandle {
    const md = this.editor.getMarkdown();
    const from = Math.max(0, Math.min(input.from, md.length));
    const to = Math.max(from, Math.min(input.to ?? from, md.length));
    const text = input.text ?? "";
    const original = md.slice(from, to);
    const s: Suggestion = {
      id: input.id ?? uid("s"),
      from,
      to,
      text,
      original,
      display: input.display ?? (text.includes("\n") || original.includes("\n") ? "block" : "inline"),
      status: input.streaming ? "streaming" : "ready",
      group: input.group,
      author: input.author,
      reason: input.reason,
      data: input.data,
    };
    this.suggestions.set(s.id, s);
    this.log(s.from, { type: "suggestion", author: s.author, itemId: s.id, text: describe(s) });
    this.render();
    return this.handle(s.id);
  }

  /** Propose new blocks after the block containing `after` (a markdown offset). Renders as a phantom block. */
  suggestBlocks(after: number, markdown: string, extra: Omit<Parameters<AIReview["suggest"]>[0], "from" | "to" | "text"> = {}): SuggestionHandle {
    const lay = this.editor.docLayout();
    const blk = lay.find((l) => after <= l.end) ?? lay[lay.length - 1];
    return this.suggest({ ...extra, from: blk.end, to: blk.end, text: "\n\n" + markdown, display: "block" });
  }

  /**
   * Suggest rewriting [from, to) as `replacement`. By default the change is split into
   * word-level suggestions (Google Docs style) that can be accepted one by one.
   */
  suggestEdit(from: number, to: number, replacement: string, o: { reason?: string; author?: string; granular?: boolean; data?: unknown } = {}): SuggestionHandle[] {
    const original = this.editor.getMarkdown().slice(from, to);
    const multiline = original.includes("\n") || replacement.includes("\n");
    if (o.granular === false || multiline) return [this.suggest({ from, to, text: replacement, reason: o.reason, author: o.author, data: o.data })];
    const group = uid("g");
    return diffWords(original, replacement).map((h) =>
      this.suggest({ from: from + h.from, to: from + h.to, text: h.text, reason: o.reason, author: o.author, group, data: o.data, display: "inline" }),
    );
  }

  getSuggestions(): Suggestion[] {
    return [...this.suggestions.values()].sort((a, b) => a.from - b.from);
  }

  accept(id: string): void {
    const s = this.suggestions.get(id);
    if (!s) return;
    this.suggestions.delete(id);
    this.hideCard();
    const text = s.display === "block" && s.from === s.to ? s.text : s.text;
    this.applying = true;
    try {
      this.editor.replaceDoc(s.from, s.to, text, "ai");
    } finally {
      this.applying = false;
    }
    if (this.opts.markAccepted && text.trim()) {
      const lead = text.length - text.trimStart().length;
      this.authored.push({ from: s.from + lead, to: s.from + text.length });
    }
    this.log(s.from, { type: "accepted", author: s.author, itemId: s.id, text: describe(s) });
    this.opts.onAccept?.(s);
    this.render();
  }

  reject(id: string): void {
    const s = this.suggestions.get(id);
    if (!s) return;
    this.suggestions.delete(id);
    this.hideCard();
    this.log(s.from, { type: "rejected", author: s.author, itemId: s.id, text: describe(s) });
    this.opts.onReject?.(s);
    this.render();
  }

  /** Accept every suggestion (or one group) as ONE undo step. */
  acceptAll(group?: string): void {
    const list = this.getSuggestions().filter((s) => !group || s.group === group);
    this.editor.transact(() => {
      // right to left so earlier offsets stay valid
      for (const s of list.reverse()) this.accept(s.id);
    });
  }

  rejectAll(group?: string): void {
    for (const s of this.getSuggestions()) if (!group || s.group === group) this.reject(s.id);
  }

  /** Move to the next / previous suggestion and open its card. */
  next(dir: 1 | -1 = 1): Suggestion | null {
    const list = this.getSuggestions();
    if (!list.length) return null;
    const cur = this.editor.getSelectionOffsets()?.from ?? 0;
    const s =
      dir > 0
        ? (list.find((x) => x.from > cur || (x.from === cur && x.id !== this.activeSuggestion)) ?? list[0])
        : ([...list].reverse().find((x) => x.from < cur) ?? list[list.length - 1]);
    this.focusSuggestion(s.id);
    return s;
  }

  focusSuggestion(id: string): void {
    const s = this.suggestions.get(id);
    if (!s) return;
    this.activeSuggestion = id;
    this.editor.selectDoc(s.from);
    this.render();
    requestAnimationFrame(() => this.showSuggestionCard(s));
  }

  private handle(id: string): SuggestionHandle {
    const get = () => this.suggestions.get(id);
    return {
      id,
      get,
      append: (chunk) => {
        const s = get();
        if (s) (s.text += chunk), this.renderSoon();
      },
      setText: (t) => {
        const s = get();
        if (s) (s.text = t), this.renderSoon();
      },
      finish: () => {
        const s = get();
        if (s) (s.status = "ready"), this.render();
      },
      accept: () => this.accept(id),
      reject: () => this.reject(id),
    };
  }

  // ---------------------------------------------------------------- notes (phantom question / issue blocks)

  addNote(input: Omit<Note, "id" | "status"> & { id?: string; streaming?: boolean }): string {
    const id = input.id ?? uid("n");
    const { streaming, ...rest } = input;
    const note: Note = { ...rest, id, status: streaming ? "streaming" : "ready" };
    this.notes.set(id, note);
    const ev = this.log(note.from, { type: "note", author: note.author, itemId: id, text: note.body });
    if (ev) this.noteEvents.set(id, ev);
    this.render();
    return id;
  }

  updateNote(id: string, patch: Partial<Omit<Note, "id">>): void {
    const n = this.notes.get(id);
    if (!n) return;
    Object.assign(n, patch);
    this.render();
  }

  /** Streaming: append to a note's body. */
  appendNote(id: string, chunk: string): void {
    const n = this.notes.get(id);
    if (n) (n.body += chunk), this.renderSoon();
    const ev = this.noteEvents.get(id);
    if (ev && n) ev.text = n.body;
  }

  /** Add a message to a note's thread (e.g. the agent's follow-up after a reply). */
  addReply(id: string, reply: { author: string; body: string }): void {
    const n = this.notes.get(id);
    if (!n) return;
    (n.replies ??= []).push(reply);
    this.log(n.from, { type: "reply", author: reply.author, itemId: id, text: reply.body });
    this.render();
  }

  removeNote(id: string): void {
    const n = this.notes.get(id);
    if (!n) return;
    this.notes.delete(id);
    this.log(n.from, { type: "dismissed", author: n.author, itemId: id, text: n.title ?? n.kind });
    this.render();
  }

  getNotes(): Note[] {
    return [...this.notes.values()].sort((a, b) => a.from - b.from);
  }

  // ---------------------------------------------------------------- @ai instructions

  /** Instruction blocks in the document, with the status of any job running for them. */
  getInstructions(): { from: number; to: number; agent: string; instruction: string; status: "idle" | InstructionJob["status"]; jobId?: string }[] {
    const lay = this.editor.docLayout();
    const out: ReturnType<AIReview["getInstructions"]> = [];
    for (const b of this.editor.getBlocks()) {
      const m = b.src.match(INSTRUCTION_RE);
      if (!m) continue;
      const l = lay.find((x) => x.id === b.id)!;
      const job = [...this.jobs.values()].find((j) => j.from === l.start);
      out.push({ from: l.start, to: l.end, agent: m[1] ?? "ai", instruction: b.src.slice(m[0].length).trim(), status: job?.status ?? "idle", jobId: job?.id });
    }
    return out;
  }

  /** Run the instruction block containing `at` (default: the caret). Returns the job id. */
  runInstruction(at?: number): string | null {
    const pos = at ?? this.editor.getSelectionOffsets()?.from ?? -1;
    const ins = this.getInstructions().find((i) => i.from <= pos && pos <= i.to);
    if (!ins || ins.status === "running" || !ins.instruction) return null;
    if (ins.jobId) this.jobs.delete(ins.jobId);
    const id = uid("j");
    const rec: { id: string; from: number; to: number; status: InstructionJob["status"]; agent: string; error?: string } = { id, from: ins.from, to: ins.to, status: "running", agent: ins.agent };
    this.jobs.set(id, rec);
    const self = this;
    const job: InstructionJob = {
      id,
      agent: ins.agent,
      instruction: ins.instruction,
      get from() {
        return rec.from;
      },
      get to() {
        return rec.to;
      },
      get status() {
        return rec.status;
      },
      set status(v) {
        rec.status = v;
      },
      context: this.getContext({ from: ins.from, to: ins.to }),
      thread: this.getThread(ins.from),
      resolve(markdown, o) {
        const h = self.suggest({ from: rec.from, to: rec.to, text: markdown, display: "block", author: rec.agent, reason: o?.reason });
        rec.status = "done";
        if (self.opts.autoApplyInstructions) h.accept();
        self.render();
      },
      stream(o) {
        rec.status = "done";
        const h = self.suggest({ from: rec.from, to: rec.to, text: "", display: "block", author: rec.agent, reason: o?.reason, streaming: true });
        if (!self.opts.autoApplyInstructions) return h;
        return { ...h, finish: () => (h.finish(), h.accept()) };
      },
      fail(message) {
        rec.status = "error";
        rec.error = message;
        self.render();
      },
      ask(question, onAnswer) {
        self.addNote({ from: rec.from, to: rec.to, kind: "question", author: rec.agent, body: question, onReply: (a, n) => (self.removeNote(n.id), onAnswer(a)) });
      },
    };
    this.render();
    void Promise.resolve(this.opts.onInstruction?.(job)).catch((e) => job.fail(String(e?.message ?? e)));
    if (!this.opts.onInstruction) job.fail("No AI agent is connected (onInstruction is not set).");
    return id;
  }

  /** Run every idle instruction in the document. */
  runInstructions(): string[] {
    return this.getInstructions()
      .filter((i) => i.status === "idle" || i.status === "error")
      .map((i) => this.runInstruction(i.from))
      .filter((x): x is string => !!x);
  }

  // ---------------------------------------------------------------- comments

  addComment(c: { from: number; to: number; id?: string; data?: unknown }): string {
    const id = c.id ?? uid("c");
    const md = this.editor.getMarkdown();
    this.comments.set(id, { id, from: c.from, to: c.to, quote: md.slice(c.from, c.to), data: c.data });
    this.log(c.from, { type: "comment", itemId: id, text: md.slice(c.from, c.to) });
    this.render();
    return id;
  }

  updateComment(id: string, patch: { data?: unknown; resolved?: boolean }): void {
    const c = this.comments.get(id);
    if (c) Object.assign(c, patch), this.render();
  }

  removeComment(id: string): void {
    if (this.comments.delete(id)) this.render();
  }

  getComments(): Comment[] {
    const md = this.editor.getMarkdown();
    return [...this.comments.values()].sort((a, b) => a.from - b.from).map((c) => ({ ...c, quote: md.slice(c.from, c.to) || c.quote }));
  }

  setActiveComment(id: string | null): void {
    this.activeComment = id;
    this.render();
  }

  /**
   * Restore saved comments, re-anchoring by quote when the offsets drifted
   * (document edited elsewhere). Returns the ids that could not be placed.
   */
  restoreComments(list: Comment[]): string[] {
    const md = this.editor.getMarkdown();
    const lost: string[] = [];
    for (const c of list) {
      let from = c.from;
      if (md.slice(c.from, c.to) !== c.quote) {
        const hits: number[] = [];
        for (let i = md.indexOf(c.quote); c.quote && i >= 0; i = md.indexOf(c.quote, i + 1)) hits.push(i);
        if (!hits.length) {
          lost.push(c.id);
          continue;
        }
        from = hits.reduce((best, h) => (Math.abs(h - c.from) < Math.abs(best - c.from) ? h : best));
      }
      this.comments.set(c.id, { ...c, from, to: from + c.quote.length });
    }
    this.render();
    return lost;
  }

  // ---------------------------------------------------------------- marks

  /** Replace all marks from one source (e.g. "fact-check", "style"). */
  setMarks(source: string, items: Omit<Mark, "id" | "source">[]): void {
    for (const [id, m] of this.marks) if (m.source === source) this.marks.delete(id);
    for (const it of items) {
      const id = uid("m");
      this.marks.set(id, { ...it, id, source });
      this.log(it.from, { type: "mark", author: source, itemId: id, text: it.message });
    }
    this.render();
  }

  clearMarks(source?: string): void {
    for (const [id, m] of this.marks) if (!source || m.source === source) this.marks.delete(id);
    this.render();
  }

  getMarks(): Mark[] {
    return [...this.marks.values()].sort((a, b) => a.from - b.from);
  }

  // ---------------------------------------------------------------- provenance

  getAuthored(): { from: number; to: number }[] {
    return this.authored.map((a) => ({ ...a }));
  }

  clearAuthored(): void {
    this.authored = [];
    this.render();
  }

  // ---------------------------------------------------------------- geometry + context

  /** Viewport rect of a markdown range (for margin UIs such as comment threads). */
  rangeRect(from: number, to: number): DOMRect | null {
    const r = this.domRange(from, Math.max(from, to));
    if (!r) return null;
    const rects = r.getClientRects();
    return rects.length ? rects[0] : r.getBoundingClientRect();
  }

  commentRect(id: string): DOMRect | null {
    const c = this.comments.get(id);
    return c ? this.rangeRect(c.from, c.to) : null;
  }

  /** Prompt context around an offset (default: the selection or caret). */
  getContext(o: { from?: number; to?: number; chars?: number } = {}): {
    before: string;
    selection: string;
    after: string;
    from: number;
    to: number;
    headingPath: string[];
    markdown: string;
  } {
    const md = this.editor.getMarkdown();
    const sel = this.editor.getSelectionOffsets() ?? { from: md.length, to: md.length };
    const from = o.from ?? sel.from;
    const to = o.to ?? sel.to;
    const n = o.chars ?? 2000;
    const path: string[] = [];
    let level = 7;
    const lay = this.editor.docLayout();
    const heads = this.editor.getHeadings();
    for (const h of [...heads].reverse()) {
      const l = lay.find((x) => x.id === h.id);
      if (l && l.start <= from && h.level < level) {
        path.unshift(h.text);
        level = h.level;
      }
    }
    return { before: md.slice(Math.max(0, from - n), from), selection: md.slice(from, to), after: md.slice(to, to + n), from, to, headingPath: path, markdown: md };
  }

  // ---------------------------------------------------------------- anchor mapping

  private map(ch: DocChange): void {
    this.knownMd = this.editor.getMarkdown();
    try {
      this.mapAnchors(ch);
    } finally {
      this.render();
    }
  }

  private mapAnchors(ch: DocChange): void {
    if (ch.kind === "load") {
      this.suggestions.clear();
      this.notes.clear();
      this.marks.clear();
      this.authored = [];
      this.comments.clear();
      this.jobs.clear();
      this.threads.clear();
      this.dirty.clear();
      return;
    }
    const md = this.editor.getMarkdown();
    const overlaps = (f: number, t: number) => ch.from < t && ch.oldTo > f;
    for (const s of [...this.suggestions.values()]) {
      const touched = overlaps(s.from, s.to) || (s.from === s.to && ch.from === s.from && ch.oldTo === s.from && !this.applying && s.display === "inline");
      s.from = mapOffset(s.from, ch, s.from === s.to ? -1 : 1);
      s.to = mapOffset(s.to, ch, -1);
      if (s.to < s.from) s.to = s.from;
      if ((touched && md.slice(s.from, s.to) !== s.original) || md.slice(s.from, s.to) !== s.original) {
        this.suggestions.delete(s.id);
        this.log(s.from, { type: "stale", author: s.author, itemId: s.id, text: describe(s) });
        this.opts.onStale?.(s);
      }
    }
    for (const n of this.notes.values()) {
      const f = mapOffset(n.from, ch, 1);
      const t = mapOffset(n.to, ch, -1);
      n.detached = t <= f && n.to > n.from;
      n.from = f;
      n.to = Math.max(f, t);
    }
    for (const t of this.threads.values()) t.anchor = mapOffset(t.anchor, ch, -1);
    this.dirty = new Set([...this.dirty].map((o) => mapOffset(o, ch, -1)));
    if (ch.kind !== "ai" && !this.applying) {
      this.dirty.add(ch.from);
      clearTimeout(this.settleTimer);
      const ms = this.opts.settleMs ?? 2500;
      const unit = this.unitAt(ch.from);
      if (ms > 0 && unit) this.settleTimer = window.setTimeout(() => this.settle(this.unitAt(ch.from)?.id ?? unit.id, "idle"), ms);
    }
    for (const j of [...this.jobs.values()]) {
      j.from = mapOffset(j.from, ch, 1);
      j.to = Math.max(j.from, mapOffset(j.to, ch, -1));
      if (j.to === j.from && j.status !== "running") this.jobs.delete(j.id); // instruction replaced
    }
    for (const c of this.comments.values()) {
      c.from = mapOffset(c.from, ch, 1);
      c.to = Math.max(c.from, mapOffset(c.to, ch, -1));
    }
    for (const m of [...this.marks.values()]) {
      if (overlaps(m.from, m.to)) this.marks.delete(m.id);
      else (m.from = mapOffset(m.from, ch, 1)), (m.to = mapOffset(m.to, ch, -1));
    }
    this.authored = this.authored
      .map((a) => ({ from: mapOffset(a.from, ch, 1), to: mapOffset(a.to, ch, -1) }))
      .filter((a) => a.to > a.from);
    this.hideCard();
  }

  // ---------------------------------------------------------------- rendering

  private raf = 0;
  private renderSoon(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private clearDom(): void {
    for (const el of this.editor.root.querySelectorAll("[data-tm-ai]")) {
      const parent = el.parentNode;
      el.remove();
      parent?.normalize?.();
    }
  }

  private domRange(from: number, to: number): Range | null {
    const a = this.editor.domPointAt(from);
    const b = this.editor.domPointAt(to);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return r;
  }

  render(): void {
    const root = this.editor.root;
    if (!root.isConnected && typeof window === "undefined") return;
    const sel = this.editor.getSelectionOffsets();
    const hadFocus = document.activeElement === root || root.contains(document.activeElement);
    // keep reply drafts across re-renders
    for (const ta of root.querySelectorAll<HTMLTextAreaElement>("textarea[data-note]")) this.replyDrafts.set(ta.dataset.note!, ta.value);
    const focusedReply = (document.activeElement as HTMLElement | null)?.dataset?.note;
    this.clearDom();

    // 1) text highlights (CSS Custom Highlight API: no DOM changes)
    const buckets: Record<string, Range[]> = Object.fromEntries(HIGHLIGHTS.map((n) => [n, []]));
    const add = (name: string, from: number, to: number) => {
      if (to <= from) return;
      const r = this.domRange(from, to);
      if (r) buckets[name].push(r);
    };
    for (const s of this.suggestions.values()) add(s.id === this.activeSuggestion ? "tm-del-active" : "tm-del", s.from, s.to);
    for (const c of this.comments.values()) if (!c.resolved) add(c.id === this.activeComment ? "tm-comment-active" : "tm-comment", c.from, c.to);
    for (const n of this.notes.values()) add(`tm-note-${n.kind}`, n.from, n.to);
    for (const m of this.marks.values()) add(`tm-mark-${m.severity}`, m.from, m.to);
    for (const a of this.authored) add("tm-authored", a.from, a.to);

    // 2) inline insertions (phantom text, not part of the document)
    const inline = [...this.suggestions.values()].filter((s) => s.display === "inline").sort((a, b) => b.to - a.to);
    for (const s of inline) {
      const pt = this.editor.domPointAt(s.to);
      if (!pt) continue;
      const span = document.createElement("span");
      span.className = `tm-ins${s.status === "streaming" ? " tm-streaming" : ""}${s.id === this.activeSuggestion ? " tm-active" : ""}`;
      span.dataset.tmUi = "";
      span.dataset.tmAi = "";
      span.dataset.sid = s.id;
      span.contentEditable = "false";
      span.setAttribute("role", "insertion");
      span.setAttribute("aria-label", `Suggested insertion: ${s.text}`);
      span.innerHTML = renderInline(s.text);
      insertAt(pt.node, pt.offset, span);
    }

    // 3) phantom blocks: block suggestions and notes, after the block holding their anchor
    const phantoms: { at: number; el: HTMLElement }[] = [];
    const byUnit = new Map<string, { unit: Unit; notes: Note[]; blocks: Suggestion[] }>();
    const units = this.getUnits();
    const unitOf = (off: number) => units.find((u) => u.from <= off && off <= u.to) ?? units[units.length - 1];
    const bucket = (off: number) => {
      const u = unitOf(off);
      if (!byUnit.has(u.id)) byUnit.set(u.id, { unit: u, notes: [], blocks: [] });
      return byUnit.get(u.id)!;
    };
    for (const s of this.suggestions.values()) if (s.display === "block") bucket(s.from).blocks.push(s);
    for (const n of this.notes.values()) bucket(n.from).notes.push(n);
    for (const g of byUnit.values()) phantoms.push({ at: g.unit.to, el: this.threadEl(g.unit, g.notes, g.blocks) });
    phantoms.sort((a, b) => a.at - b.at);
    for (const p of phantoms) {
      const pt = this.editor.domPointAt(p.at);
      let after: Element | null = pt?.block ?? null;
      while (after?.nextElementSibling?.hasAttribute("data-tm-ai")) after = after.nextElementSibling;
      if (after) after.after(p.el);
      else root.append(p.el);
    }

    for (const el of root.querySelectorAll<HTMLElement>("[data-ai-status]")) {
      delete el.dataset.aiStatus;
      delete el.dataset.aiError;
    }
    for (const j of [...this.jobs.values()]) {
      const blk = this.editor.domPointAt(j.from)?.block;
      if (!blk || blk.dataset.ext !== "instruction") {
        if (j.status !== "running") this.jobs.delete(j.id); // instruction replaced or rewritten
        continue;
      }
      blk.dataset.aiStatus = j.status;
      if (j.error) blk.dataset.aiError = j.error;
    }

    if (hasHighlights()) for (const n of HIGHLIGHTS) CSS.highlights.set(n, new Highlight(...buckets[n]));
    root.classList.toggle("tm-has-review", this.suggestions.size + this.notes.size > 0);

    // restore caret / reply focus disturbed by text-node splits
    if (focusedReply) root.querySelector<HTMLTextAreaElement>(`textarea[data-note="${focusedReply}"]`)?.focus();
    else if (sel && hadFocus) this.editor.selectDocQuiet(sel.from, sel.to);
  }

  private header(kind: string, label: string, author?: string): string {
    return (
      `<div class="tm-ph-head"><span class="tm-ph-badge tm-ph-${kind}">${escHtml(label)}</span>` +
      (author ? `<span class="tm-ph-author">${escHtml(author)}</span>` : "") +
      `<span class="tm-ph-spacer"></span></div>`
    );
  }

  private threadEl(unit: Unit, notes: Note[], blocks: Suggestion[]): HTMLElement {
    const t = this.threadFor(unit, true)!;
    const el = phantomShell("thread", t.id);
    const kinds = new Set(notes.map((n) => n.kind));
    const main = kinds.has("issue") ? "issue" : kinds.has("question") ? "question" : notes.length ? notes[0].kind : null;
    el.classList.add(main ? `tm-note-${main}` : "tm-phantom-suggestion");
    if ([...notes, ...blocks].some((x) => x.status === "streaming")) el.classList.add("tm-streaming");
    const authors = [...new Set([...notes.map((n) => n.author), ...blocks.map((b) => b.author)].filter(Boolean))] as string[];
    const inline = this.getSuggestions().filter((s) => s.display === "inline" && unit.from <= s.from && s.from <= unit.to).length;
    const head = document.createElement("div");
    head.className = "tm-ph-head";
    head.innerHTML =
      `<span class="tm-ph-badge tm-ph-thread">Thread</span>` +
      (authors.length ? `<span class="tm-ph-author">${escHtml(authors.join(", "))}</span>` : "") +
      (inline ? `<span class="tm-ph-count">${inline} inline edit${inline > 1 ? "s" : ""}</span>` : "") +
      `<span class="tm-ph-spacer"></span>`;
    if (t.history.length) {
      const hb = button(this.openHistory.has(t.id) ? "Hide history" : `History (${t.history.length})`, false, () => {
        if (this.openHistory.has(t.id)) this.openHistory.delete(t.id);
        else this.openHistory.add(t.id);
        this.render();
      });
      hb.classList.add("tm-btn-small");
      head.append(hb);
    }
    el.append(head);
    for (const n of notes.sort((a, b) => a.from - b.from)) el.append(this.noteEl(n));
    for (const s of blocks) el.append(this.blockSuggestionEl(s));
    if (authors.length === 1) for (const a of el.querySelectorAll(".tm-ph-section .tm-ph-head .tm-ph-author")) a.remove(); // one author: named once
    if (this.openHistory.has(t.id)) {
      const h = document.createElement("ol");
      h.className = "tm-ph-history";
      h.innerHTML = t.history
        .map((e) => `<li data-type="${e.type}"><span class="tm-ph-ev">${e.type}</span>${e.author ? `<span class="tm-ph-author">${escHtml(e.author)}</span>` : ""}<span class="tm-ph-evtext">${escHtml(e.text.slice(0, 160))}</span></li>`)
        .join("");
      el.append(h);
    }
    // ONE reply box per thread
    const replyTarget = [...notes].reverse().find((n) => n.onReply);
    if (this.opts.onThreadReply || replyTarget) {
      const row = document.createElement("div");
      row.className = "tm-ph-actions tm-ph-replyrow";
      const ta = document.createElement("textarea");
      ta.className = "tm-ph-input";
      ta.rows = 1;
      ta.dataset.note = t.id;
      ta.placeholder = replyTarget?.replyPlaceholder ?? "Reply to this thread…";
      ta.setAttribute("aria-label", "Reply to this thread");
      ta.value = this.replyDrafts.get(t.id) ?? "";
      const send = async () => {
        const text = ta.value.trim();
        if (!text) return;
        this.replyDrafts.delete(t.id);
        t.history.push({ type: "reply", author: "You", text, time: Date.now() });
        if (replyTarget) (replyTarget.replies ??= []).push({ author: "You", body: text });
        this.render();
        const thread = this.getThread(unit.id)!;
        if (this.opts.onThreadReply) await this.opts.onThreadReply(thread, text);
        else await replyTarget!.onReply!(text, replyTarget!);
      };
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void send();
        }
      });
      ta.addEventListener("input", () => {
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      });
      for (const ev of ["beforeinput", "input", "paste", "cut", "copy", "mousedown"]) ta.addEventListener(ev, (e) => e.stopPropagation());
      row.append(ta, button("Send", true, () => void send()));
      el.append(row);
    }
    el.setAttribute("aria-label", `Review thread: ${notes.length} note${notes.length === 1 ? "" : "s"}, ${blocks.length + inline} suggestion${blocks.length + inline === 1 ? "" : "s"}`);
    return el;
  }

  private blockSuggestionEl(s: Suggestion): HTMLElement {
    const el = section("suggestion", s.id);
    el.dataset.sid = s.id;
    if (s.status === "streaming") el.classList.add("tm-streaming");
    const body = s.text.replace(/^\n+/, "");
    el.innerHTML =
      this.header("suggestion", INSTRUCTION_RE.test(s.original) ? `Result from @${s.author ?? "ai"}` : s.original ? "Suggested rewrite" : "Suggested addition", s.author && !INSTRUCTION_RE.test(s.original) ? s.author : undefined) +
      (s.reason ? `<div class="tm-ph-reason">${renderInline(s.reason)}</div>` : "") +
      `<div class="tm-ph-body tm-ins-block">${body ? renderMarkdown(body) : `<div class="tm-ph-wait"></div>`}</div>` +
      `<div class="tm-ph-actions"></div>`;
    const actions = el.querySelector(".tm-ph-actions")!;
    actions.append(
      button("Accept", true, () => this.accept(s.id), "Alt+Enter"),
      button("Reject", false, () => this.reject(s.id), "Alt+Backspace"),
    );
    el.setAttribute("aria-label", `${s.original ? "Suggested rewrite" : "Suggested addition"}${s.author ? ` from ${s.author}` : ""}`);
    return el;
  }

  private noteEl(n: Note): HTMLElement {
    const el = section("note", n.id);
    el.classList.add(`tm-note-${n.kind}`);
    if (n.status === "streaming") el.classList.add("tm-streaming");
    if (n.detached) el.classList.add("tm-detached");
    const labels: Record<NoteKind, string> = { question: "Question", issue: "Issue", info: "Note", success: "Verified" };
    const quote = this.editor.getMarkdown().slice(n.from, n.to);
    el.innerHTML =
      this.header(n.kind, n.title ?? labels[n.kind], n.author) +
      (quote && quote.length < 240 ? `<div class="tm-ph-quote">${escHtml(quote.replace(/[`*_~=]|\[\^?|\]\([^)]*\)/g, ""))}</div>` : "") +
      `<div class="tm-ph-body">${n.body ? renderMarkdown(n.body) : `<div class="tm-ph-wait"></div>`}</div>` +
      (n.replies ?? [])
        .map((r) => `<div class="tm-ph-reply"><span class="tm-ph-author">${escHtml(r.author)}</span>${renderMarkdown(r.body)}</div>`)
        .join("") +
      `<div class="tm-ph-actions"></div>`;
    const actions = el.querySelector<HTMLElement>(".tm-ph-actions")!;
    for (const a of n.actions ?? []) actions.append(button(a.label, !!a.primary, () => void a.run(n, { review: this, editor: this.editor })));
    actions.append(
      button("Dismiss", false, () => {
        this.removeNote(n.id);
        this.opts.onNoteDismiss?.(n);
      }),
    );
    el.setAttribute("aria-label", `${labels[n.kind]}${n.author ? ` from ${n.author}` : ""}: ${n.body.slice(0, 120)}`);
    return el;
  }

  // ---------------------------------------------------------------- interaction

  private key(e: KeyboardEvent): boolean {
    if (e.key === "Escape" && this.card) return this.hideCard(), true;
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing) {
      const sel = this.editor.getSelectionOffsets();
      const ins = sel && sel.from === sel.to && this.getInstructions().find((i) => i.to === sel.from);
      if (ins && ins.instruction) {
        e.preventDefault();
        this.runInstruction(ins.from);
        return true;
      }
    }
    if (!e.altKey || e.metaKey || e.ctrlKey) return false;
    const at = this.editor.getSelectionOffsets()?.from;
    const cur =
      (this.activeSuggestion && this.suggestions.get(this.activeSuggestion)) ||
      this.getSuggestions().find((s) => at !== undefined && s.from <= at && at <= s.to) ||
      null;
    if (e.key === "Enter" && cur) return e.preventDefault(), this.accept(cur.id), true;
    if (e.key === "Backspace" && cur) return e.preventDefault(), this.reject(cur.id), true;
    if (e.key === "]" || e.code === "BracketRight") return e.preventDefault(), this.next(1), true;
    if (e.key === "[" || e.code === "BracketLeft") return e.preventDefault(), this.next(-1), true;
    return false;
  }

  private pointer(e: MouseEvent, off: number | null): boolean {
    const t = e.target as HTMLElement;
    const ins = t.closest<HTMLElement>(".tm-ins[data-sid]");
    if (ins) {
      e.preventDefault();
      const s = this.suggestions.get(ins.dataset.sid!);
      if (s) (this.activeSuggestion = s.id), this.render(), requestAnimationFrame(() => this.showSuggestionCard(s));
      return true;
    }
    if (t.closest("[data-tm-ai]")) return true; // clicks inside phantoms are theirs
    this.hideCard();
    if (off === null) return false;
    const s = this.getSuggestions().find((x) => x.from <= off && off <= x.to && x.to > x.from);
    if (s) {
      this.activeSuggestion = s.id;
      requestAnimationFrame(() => this.showSuggestionCard(s));
      return false;
    }
    const m = this.getMarks().find((x) => x.from <= off && off <= x.to);
    if (m) {
      requestAnimationFrame(() => this.showMarkCard(m));
      return false;
    }
    const c = this.getComments().find((x) => !x.resolved && x.from <= off && off <= x.to);
    if (c) {
      this.setActiveComment(c.id);
      this.opts.onCommentClick?.(c, e);
    } else if (this.activeComment) this.setActiveComment(null);
    if (this.activeSuggestion) (this.activeSuggestion = null), this.render();
    return false;
  }

  private ensureCard(): HTMLDivElement {
    if (!this.card) {
      this.card = document.createElement("div");
      this.card.className = "tm-review-card";
      this.card.setAttribute("role", "dialog");
      this.card.addEventListener("mousedown", (e) => e.preventDefault());
    }
    if (!this.card.isConnected) document.body.append(this.card);
    const cs = getComputedStyle(this.editor.root);
    for (const v of ["--tm-fg", "--tm-bg", "--tm-meta", "--tm-accent", "--tm-code-bg", "--tm-border"]) this.card.style.setProperty(v, cs.getPropertyValue(v));
    return this.card;
  }

  private placeCard(rect: DOMRect | null): void {
    if (!this.card || !rect) return;
    const h = this.card.offsetHeight;
    const below = rect.bottom + 8 + h < innerHeight;
    this.card.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - this.card.offsetWidth - 8)) + scrollX}px`;
    this.card.style.top = `${(below ? rect.bottom + 8 : rect.top - h - 8) + scrollY}px`;
  }

  private showSuggestionCard(s: Suggestion): void {
    if (this.opts.card === false || s.display === "block") return;
    const c = this.ensureCard();
    const what = s.from === s.to ? "Add" : s.text ? "Replace" : "Delete";
    c.innerHTML =
      `<div class="tm-rc-head"><b>${what}</b>${s.author ? ` <span>· ${escHtml(s.author)}</span>` : ""}</div>` +
      (s.original ? `<div class="tm-rc-diff"><del>${escHtml(s.original)}</del>${s.text ? ` → <ins>${escHtml(s.text)}</ins>` : ""}</div>` : `<div class="tm-rc-diff"><ins>${escHtml(s.text)}</ins></div>`) +
      (s.reason ? `<div class="tm-rc-reason">${renderInline(s.reason)}</div>` : "") +
      `<div class="tm-rc-actions"></div>`;
    c.querySelector(".tm-rc-actions")!.append(
      button("Accept", true, () => this.accept(s.id), "Alt+Enter"),
      button("Reject", false, () => this.reject(s.id), "Alt+Backspace"),
    );
    this.placeCard(this.rangeRect(s.from, Math.max(s.to, s.from)) ?? this.editor.root.querySelector(`[data-sid="${s.id}"]`)?.getBoundingClientRect() ?? null);
  }

  private showMarkCard(m: Mark): void {
    if (this.opts.card === false) return;
    const c = this.ensureCard();
    c.innerHTML =
      `<div class="tm-rc-head"><span class="tm-rc-sev tm-rc-${m.severity}"></span><b>${escHtml(m.source)}</b></div>` +
      `<div class="tm-rc-reason">${renderInline(m.message)}</div><div class="tm-rc-actions"></div>`;
    const actions = c.querySelector(".tm-rc-actions")!;
    for (const f of m.fixes ?? [])
      actions.append(
        button(f.label, true, () => {
          this.marks.delete(m.id);
          this.hideCard();
          this.editor.replaceDoc(m.from, m.to, f.text, "ai");
        }),
      );
    actions.append(
      button("Ignore", false, () => {
        this.marks.delete(m.id);
        this.hideCard();
        this.render();
      }),
    );
    this.placeCard(this.rangeRect(m.from, m.to));
  }

  private hideCard = (): void => {
    this.card?.remove();
  };
}

const HIGHLIGHTS = [
  "tm-del",
  "tm-del-active",
  "tm-comment",
  "tm-comment-active",
  "tm-note-question",
  "tm-note-issue",
  "tm-note-info",
  "tm-note-success",
  "tm-mark-error",
  "tm-mark-warning",
  "tm-mark-info",
  "tm-mark-style",
  "tm-authored",
];

function section(kind: string, id: string): HTMLElement {
  const el = document.createElement("section");
  el.className = `tm-ph-section tm-ph-${kind}`;
  el.dataset.id = id;
  return el;
}

function describe(s: Suggestion): string {
  const o = s.original.length > 80 ? s.original.slice(0, 77) + "…" : s.original;
  const t = s.text.length > 80 ? s.text.slice(0, 77) + "…" : s.text;
  return s.from === s.to ? `+ "${t.trim()}"` : s.text ? `"${o}" → "${t.trim()}"` : `− "${o}"`;
}

function phantomShell(kind: string, id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `tm-phantom tm-phantom-${kind}`;
  el.dataset.tmUi = "";
  el.dataset.tmAi = "";
  el.dataset.id = id;
  el.contentEditable = "false";
  el.setAttribute("role", "note");
  return el;
}

function button(label: string, primary: boolean, run: () => void, shortcut?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tm-btn${primary ? " tm-btn-primary" : ""}`;
  b.textContent = label;
  if (shortcut) {
    b.title = `${label} (${shortcut})`;
    b.setAttribute("aria-keyshortcuts", shortcut);
  }
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  });
  return b;
}

function insertAt(node: Node, offset: number, el: HTMLElement): void {
  if (node.nodeType === 3) {
    const t = node as Text;
    if (offset >= t.length) t.after(el);
    else if (offset === 0) t.before(el);
    else t.splitText(offset).before(el);
  } else {
    const ref = node.childNodes[offset] ?? null;
    node.insertBefore(el, ref);
  }
}

export function createReview(editor: Editor, opts?: AIReviewOptions): AIReview {
  return new AIReview(editor, opts);
}
