/**
 * Accessibility layer: a polite live region owned by the editor, block-type /
 * task / AI announcements, task checkbox semantics, and keyboard access to
 * AI thread cards. Installed by the Editor; uses only its public hooks.
 */
import type { Editor } from "./editor";
import type { BlockType } from "./block";
import type { AIReview, ThreadEvent } from "./ai";

const BLOCK_LABELS: Partial<Record<BlockType, string>> = {
  paragraph: "Paragraph",
  quote: "Quote",
  ul: "Bulleted list",
  ol: "Numbered list",
  task: "Task list",
  code: "Code block",
  math: "Math block",
  table: "Table",
  footnote: "Footnote",
  hr: "Divider",
  frontmatter: "Front matter",
};

/** Human label of a block for announcements ("Heading 2", "Bulleted list"). */
export function blockLabel(type: BlockType, src = ""): string {
  if (type === "heading") return `Heading ${(src.match(/^#+/)?.[0].length ?? 1)}`;
  return BLOCK_LABELS[type] ?? type;
}

const NOTE_LABELS: Record<string, string> = { question: "Question", issue: "Issue", info: "Note", success: "Note" };

const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const by = (a?: string) => (a ? ` by ${a}` : "");

/** Spoken text for an AI thread event, or null when it should stay silent. */
export function aiEventText(ev: Omit<ThreadEvent, "time">, review?: AIReview): string | null {
  switch (ev.type) {
    case "suggestion":
      return `Suggestion added${by(ev.author)}: ${clip(ev.text)}`;
    case "accepted":
      return `Suggestion accepted: ${clip(ev.text)}`;
    case "rejected":
      return `Suggestion rejected`;
    case "note": {
      const n = review?.getNotes().find((x) => x.id === ev.itemId);
      return `${NOTE_LABELS[n?.kind ?? "info"] ?? "Note"} added${by(ev.author)}: ${clip(ev.text)}`;
    }
    case "reply":
      return `Reply${by(ev.author)}: ${clip(ev.text)}`;
    case "comment":
      return "Comment added";
    case "dismissed":
      return "Note dismissed";
    default:
      return null; // marks arrive in bulk, stale is internal: announced on caret entry instead
  }
}

/** Visually hidden polite live region. */
export class Announcer {
  readonly el: HTMLElement;
  private flip = false;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "tm-sr-only tm-live";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
    this.el.setAttribute("aria-atomic", "true");
    (host.parentElement ?? document.body).append(this.el);
  }

  /** Speak text. Repeating the same text still re-announces. */
  announce(text: string): void {
    if (!text) return;
    this.flip = !this.flip;
    this.el.textContent = this.flip ? text : `${text} `;
  }

  destroy(): void {
    this.el.remove();
  }
}

function taskLabel(src: string): string {
  return src.replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "").replace(/[*_`~=[\]]/g, "").trim() || "Task";
}

/** Wire the semantics and keyboard behaviour (listeners end with `signal`). */
export function installA11y(editor: Editor, announcer: Announcer, signal: AbortSignal): void {
  const root = editor.root;
  const say = (t: string) => announcer.announce(t);
  let types = new Map(editor.getBlocks().map((b) => [b.id, blockLabel(b.type, b.src)]));

  editor.onDocChange((c) => {
    const blocks = editor.getBlocks();
    const next = new Map(blocks.map((b) => [b.id, blockLabel(b.type, b.src)]));
    if (c.kind !== "load" && c.kind !== "undo") {
      const caret = editor.caretBlockId();
      const changed = blocks.filter((b) => types.has(b.id) && types.get(b.id) !== next.get(b.id));
      const hit = changed.find((b) => b.id === caret) ?? (changed.length === 1 ? changed[0] : undefined);
      if (hit) say(next.get(hit.id)!);
    }
    types = next;
  });

  // task checkboxes and images: semantics refreshed after every render
  const decorate = () => {
    for (const box of root.querySelectorAll<HTMLElement>(".md-task-box")) {
      const el = box.closest<HTMLElement>("[data-bid]");
      const src = el ? editor.getBlocks().find((b) => b.id === el.dataset.bid)?.src ?? "" : "";
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", String(/\[[xX]\]/.test(src)));
      box.setAttribute("aria-label", taskLabel(src));
      box.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    }
    for (const img of root.querySelectorAll<HTMLImageElement>("img:not([alt])")) img.alt = "";
  };
  decorate();
  editor.onRender(decorate);

  let cardReturn: number | null = null;
  editor.onKey((e) => {
    const target = e.target as HTMLElement | null;
    // Esc inside a thread card: back to the caret
    if (e.key === "Escape" && target?.closest?.(".tm-phantom")) {
      e.preventDefault();
      root.focus();
      editor.selectDoc(cardReturn ?? 0);
      return true;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter" && !e.shiftKey && !e.altKey) {
      const id = editor.caretBlockId();
      const b = id ? editor.getBlocks().find((x) => x.id === id) : undefined;
      if (b?.type !== "task") return false;
      e.preventDefault();
      const sel = editor.getSelectionOffsets();
      const done = !/\[[xX]\]/.test(b.src);
      editor.updateBlock(b.id, b.src.replace(/\[([ xX])\]/, done ? "[x]" : "[ ]"));
      if (sel) editor.selectDoc(sel.from, sel.to);
      say(done ? "Checked" : "Not checked");
      return true;
    }
    if (e.altKey && e.shiftKey && e.code === "KeyT") {
      const card = threadCardForCaret(editor);
      if (!card) {
        say("No review thread on this block");
        return true;
      }
      e.preventDefault();
      cardReturn = editor.getSelectionOffsets()?.from ?? null;
      const first = card.querySelector<HTMLElement>("button, textarea, [tabindex]");
      (first ?? card).focus();
      return true;
    }
    return false;
  });

  // non-visual equivalent for highlight-only review state
  let lastSpoken = "";
  document.addEventListener(
    "selectionchange",
    () => {
      const review = (editor as unknown as { _ai?: AIReview })._ai;
      const sel = editor.getSelectionOffsets();
      if (!review || !sel || sel.from !== sel.to) return;
      const text = rangeTextAt(review, sel.from);
      if (text && text !== lastSpoken) say(text);
      lastSpoken = text ?? "";
    },
    { signal },
  );
}

/** What the caret sits in: a deletion suggestion, a comment, or a mark. */
export function rangeTextAt(review: AIReview, at: number): string | null {
  const inside = (r: { from: number; to: number }) => r.from < r.to && r.from <= at && at <= r.to;
  const del = review.getSuggestions().find((s) => s.display === "inline" && s.from < s.to && inside(s));
  if (del) return `Suggested ${del.text ? "replacement" : "deletion"}${by(del.author)}: ${clip(del.original, 80)}`;
  const c = review.getComments().find((x) => !x.resolved && inside(x));
  if (c) return `Comment: ${clip(c.quote, 80)}`;
  const m = review.getMarks().find(inside);
  if (m) return `${m.severity === "style" ? "Style" : m.severity[0].toUpperCase() + m.severity.slice(1)}: ${clip(m.message, 100)}`;
  return null;
}

function threadCardForCaret(editor: Editor): HTMLElement | null {
  const review = (editor as unknown as { _ai?: AIReview })._ai;
  const id = editor.caretBlockId();
  if (!review || !id) return null;
  const t = review.getThread(id);
  return t ? editor.root.querySelector<HTMLElement>(`.tm-phantom-thread[data-id="${CSS.escape(t.id)}"]`) : null;
}
