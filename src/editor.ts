/**
 * The editor. One contenteditable root; each child element is one block.
 *
 * Edit loop (the part that makes it feel like Typora):
 *   1. Plain typing is left to the browser (fast, IME/autocorrect friendly).
 *   2. On `input` we read the caret block's textContent, which IS its markdown
 *      source, re-render that block, and only touch the DOM if the HTML changed.
 *   3. The caret is restored by raw offset, then the inline element under the
 *      caret gets `.md-expand` so its syntax characters become visible.
 * Structural edits (Enter, merging blocks, cross-block selections, paste,
 * undo) never go through the browser; they are model operations.
 */
import { readFrontmatter } from "./block";
import { separator } from "./block";
import { Block, BlockType, blockType, continuation, fenceInfo, indentOf, mkBlock, parse, pipesOf, prefixLen, renderBlock, serialize } from "./block";
import "./math";
import { SuggestItem, Suggester, matchBlockExt, registerExtension, registry } from "./extension";
import { coreExtensions } from "./extensions";
import { Folding } from "./fold";
import type { LinkPreviewFn } from "./linkcard";
import { SuggestMenu } from "./suggest";
import { AIReview, AIReviewOptions } from "./ai";
import { Finder } from "./find";
import { DocumentMetadata, extractMetadata } from "./metadata";
import { FenceRenderer, registerFenceRenderer } from "./preview";
import { EmbedPolicy, altFromName, buildEmbed, defaultEmbedPolicy, embedHtmlFor, fileToDataUrl, mdUrl } from "./media";
import { Pos, blockElOf, domPoint, placeCaret, posOf, sourceText } from "./caret";
import { Announcer, installA11y } from "./a11y";
import { TypingAidOptions, TypingAids, TypingCtx } from "./typing";

export interface EditorOptions {
  /** Initial markdown. */
  value?: string;
  /** Called after every change with the full markdown document. */
  onChange?: (markdown: string) => void;
  /** Called when the caret moves or the document changes; use it to drive toolbars. */
  onStateChange?: (state: EditorState) => void;
  /** Shown while the document is empty. */
  placeholder?: string;
  /** Start in read-only mode (rendered, syntax never revealed, no editing). */
  readOnly?: boolean;
  /** Browser spellcheck (default true). */
  spellcheck?: boolean;
  /**
   * Store an image (from paste, drop or the picker) and return its URL.
   * Default: inline as a data: URL — fine for demos, heavy for real documents.
   */
  uploadImage?: (file: File) => Promise<string>;
  /** Map an image's markdown src to the URL the browser loads (e.g. resolve relative paths). */
  resolveImageUrl?: (src: string) => string;
  /** Which iframe/video/audio sources may load. Default: https, not this page's origin. */
  embedPolicy?: EmbedPolicy;
  /** Built-in find & replace panel and Cmd/Ctrl+F shortcut (default true). */
  find?: boolean;
  /** Options for the AI review layer (editor.ai). */
  ai?: AIReviewOptions;
  /** Register the built-in syntax extensions (@[](url) embeds, [toc], callouts, / menu). Default true. */
  coreExtensions?: boolean;
  /** Fence renderers by language, e.g. { mermaid: mermaidRenderer(() => import("mermaid")) }. Registered globally. */
  renderers?: Record<string, FenceRenderer>;
  /** Metadata for link cards (a bare URL alone on a line). The engine never fetches by itself. */
  linkPreview?: LinkPreviewFn;
  /** Wrap selection on typed marks, auto-close brackets, smart punctuation (default all on). */
  typingAids?: boolean | TypingAidOptions;
  /** Accessible name of the editor (default "Markdown editor"). */
  ariaLabel?: string;
}

/** Inline formats that can be toggled with `exec`. */
export type InlineFormat = "bold" | "italic" | "code" | "strike" | "highlight";

export type Command =
  | { type: InlineFormat }
  | { type: "heading"; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "bulletList" | "orderedList" | "taskList" | "quote" }
  | { type: "codeBlock" | "mathBlock" | "table" | "hr" }
  | { type: "image"; src: string; alt?: string; title?: string }
  | { type: "imagePicker" } // open a file dialog, upload, insert
  | { type: "embed"; url: string } // YouTube/Vimeo/Loom/... URL, media file URL, or raw <iframe> HTML
  | { type: "diagram"; lang?: string } // fenced block for a registered renderer (default "mermaid")
  | { type: "insertText"; text: string; caret?: number } // at the caret (replacing the selection); caret = offset into text
  | { type: "insertBlock"; src: string; caret?: number } // new block after the caret block
  | { type: "undo" | "redo" };

/** What is under the caret, for toolbars and status bars. */
export interface EditorState {
  /** Block type at the caret ("paragraph", "heading", "ul", "table", ...). */
  block: BlockType | null;
  /** Heading level, 0 when not a heading. */
  headingLevel: number;
  /** Inline formats the caret is inside. */
  formats: InlineFormat[];
  canUndo: boolean;
  canRedo: boolean;
}

const MARKS: Record<InlineFormat, string> = { bold: "**", italic: "*", code: "`", strike: "~~", highlight: "==" };
const FORMAT_CLASS: Record<string, InlineFormat> = {
  "md-strong": "bold",
  "md-em": "italic",
  "md-code": "code",
  "md-del": "strike",
  "md-mark": "highlight",
};

interface Snapshot {
  blocks: Block[];
  caret: Pos | null;
}

let coreRegistered = false;

/** One document change in markdown offsets: [from, oldTo) became [from, newTo). */
export interface DocChange {
  from: number;
  oldTo: number;
  newTo: number;
  /** "type" | "edit" | "undo" | "load" | ... */
  kind: string;
}

type BlockEl = HTMLElement & { _html?: string; _cleanup?: () => void };

/** data-* of an inline extension element, minus engine bookkeeping. */
function extData(el: HTMLElement): Record<string, string> {
  const { s: _s, e: _e, ext: _x, ...rest } = el.dataset as Record<string, string>;
  return rest;
}

export class Editor {
  readonly root: HTMLElement;
  private blocks: Block[] = [];
  private els = new Map<string, BlockEl>();
  private composing = false;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastKind = "";
  private lastTime = 0;
  private current!: Snapshot;
  private opts: EditorOptions;
  private readOnly = false;
  private abort = new AbortController();
  private lastState = "";
  private menu: SuggestMenu;
  private suggest: { bid: string; start: number; sg: Suggester; token: number } | null = null;
  private suggestToken = 0;
  private dismissed = "";
  private lastMd = "";
  private txDepth = 0;
  private txPushed = false;
  private changeHooks: ((c: DocChange) => void)[] = [];
  private renderHooks: (() => void)[] = [];
  private keyHooks: ((e: KeyboardEvent) => boolean)[] = [];
  private typing!: TypingAids;
  private pointerHooks: ((e: MouseEvent, offset: number | null) => boolean)[] = [];
  private announcer!: Announcer;

  constructor(root: HTMLElement, opts: EditorOptions = {}) {
    this.root = root;
    this.opts = opts;
    root.classList.add("tm-editor");
    root.spellcheck = opts.spellcheck ?? true;
    if (opts.placeholder) root.dataset.placeholder = opts.placeholder;
    if (opts.coreExtensions !== false && !coreRegistered) {
      coreRegistered = true;
      for (const x of coreExtensions) registerExtension(x);
    }
    root.setAttribute("role", "textbox");
    root.setAttribute("aria-multiline", "true");
    root.setAttribute("aria-label", opts.ariaLabel ?? "Markdown editor");
    this.announcer = new Announcer(root);
    this.menu = new SuggestMenu(root);
    this.menu.onChoose = (item) => this.applySuggestion(item);
    this.setReadOnly(!!opts.readOnly);
    for (const [lang, r] of Object.entries(opts.renderers ?? {})) registerFenceRenderer(lang, r);
    this.setMarkdown(opts.value ?? "");
    installA11y(this, this.announcer, this.abort.signal);
    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void) =>
      root.addEventListener(t, (e) => !this.readOnly && f(e), { signal: this.abort.signal });
    on("beforeinput", (e) => this.onBeforeInput(e as InputEvent));
    on("input", () => this.onInput());
    this.typing = new TypingAids(opts.typingAids);
    on("keydown", (e) => (this.typing.noteKey(e), this.onKeyDown(e)));
    on("compositionstart", () => (this.composing = true));
    on("compositionend", () => {
      this.composing = false;
      this.onInput();
    });
    on("copy", (e) => this.onCopy(e, false));
    on("cut", (e) => this.onCopy(e, true));
    on("paste", (e) => this.onPasteFiles(e));
    on("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    on("drop", (e) => this.onDropFiles(e));
    root.addEventListener("mousedown", (e) => this.onMouseDown(e), { signal: this.abort.signal });
    document.addEventListener("selectionchange", () => this.syncFocus(), { signal: this.abort.signal });
    if (opts.ai) void this.ai;
    if (opts.find !== false) void this.find; // start tracking activity right away when the host configured the AI layer
    void this.folding;
  }

  /** Remove every listener and leave the rendered (read-only) document in place. */
  destroy(): void {
    this.abort.abort();
    this.announcer.destroy();
    this.menu.destroy();
    this._ai?.destroy();
    this._find?.destroy();
    for (const el of this.els.values()) el._cleanup?.();
    this.applyFocus(null);
    this.root.contentEditable = "false";
  }

  // ---------- public API ----------

  getMarkdown(): string {
    return serialize(this.blocks);
  }

  /** Replace the whole document. Clears undo history. */
  setMarkdown(md: string): void {
    this.blocks = parse(md);
    this.root.innerHTML = "";
    this.els.clear();
    this.reconcile();
    this.current = this.snapshot(null);
    this.undoStack = [];
    this.redoStack = [];
    if (this.changeHooks) this.emitChange("load");
    this.emitState();
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.root.contentEditable = readOnly ? "false" : "true";
    this.root.classList.toggle("tm-readonly", readOnly);
    this.root.setAttribute("aria-readonly", String(readOnly));
    if (readOnly) this.applyFocus(null);
  }

  /**
   * Source mode: the SAME document, with every markdown character visible and
   * previews hidden. Editing works identically; the caret stays where it was.
   */
  setSourceMode(on: boolean): void {
    const sel = this.getSel();
    if (on !== this.isSourceMode()) this.announce(on ? "Source mode on: markdown syntax visible" : "Source mode off");
    this.root.classList.toggle("tm-source-mode", on);
    if (sel) this.setCaret(sel.start, sel.collapsed ? undefined : sel.end);
  }

  isSourceMode(): boolean {
    return this.root.classList.contains("tm-source-mode");
  }

  /** Focus mode: fade every block except the one being written. */
  setFocusMode(on: boolean): void {
    this.root.classList.toggle("tm-focus-mode", on);
  }

  /** Words and characters in the document (markdown syntax excluded where cheap). */
  getStats(): { words: number; characters: number; readingMinutes: number } {
    const text = this.blocks
      .filter((b) => !["code", "math", "frontmatter", "html", "widget"].includes(blockType(b.src)))
      .map((b) => b.src.slice(prefixLen(b.src)).replace(/!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|[#*_`~=\[\]>|]/g, " "))
      .join(" ");
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
    return { words, characters: text.replace(/\s+/g, "").length, readingMinutes: Math.max(1, Math.round(words / 230)) };
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  /** Speak text through the editor's polite live region (screen readers). */
  announce(text: string): void {
    this.announcer?.announce(text);
  }

  /** The live region element (for hosts that want to inspect or restyle it). */
  get liveRegion(): HTMLElement {
    return this.announcer.el;
  }

  /** Put the caret at the end of the document. */
  focus(): void {
    const last = this.blocks[this.blocks.length - 1];
    this.root.focus();
    this.setCaret({ bid: last.id, off: last.src.length });
  }

  /** Run an editing command at the caret / selection (for toolbars and menus). */
  exec(cmd: Command): void {
    if (this.readOnly) return;
    if (cmd.type === "undo") return this.undo();
    if (cmd.type === "redo") return this.redo();
    if (cmd.type in MARKS) return this.wrapSelection(MARKS[cmd.type as InlineFormat]);
    const sel = this.getSel() ?? { start: this.endOf(this.blocks[this.blocks.length - 1]) };
    const b = this.block(sel.start.bid)!;
    const body = b.src.slice(prefixLen(b.src));
    const inBody = Math.max(0, sel.start.off - prefixLen(b.src));
    const setPrefix = (prefix: string) => {
      const cur = b.src.slice(0, prefixLen(b.src));
      const next = cur === prefix ? "" : prefix; // same command again toggles it off
      b.src = next + body;
      this.after({ bid: b.id, off: next.length + inBody });
    };
    switch (cmd.type) {
      case "heading":
        return setPrefix(cmd.level ? "#".repeat(cmd.level) + " " : "");
      case "bulletList":
        return setPrefix("- ");
      case "orderedList":
        return setPrefix("1. ");
      case "taskList":
        return setPrefix("- [ ] ");
      case "quote":
        return setPrefix("> ");
      case "hr":
        return this.insertBlockAfter(b, "---"), this.insertBlockAfter(this.blocks[this.index(b.id) + 1], "");
      case "image": {
        const md = `![${(cmd.alt ?? "").replace(/[\[\]]/g, "")}](${mdUrl(cmd.src)}${cmd.title ? ` "${cmd.title.replace(/"/g, "'")}"` : ""})`;
        const at = sel.start;
        return this.replaceRange(at, "end" in sel && sel.end ? sel.end : at, md);
      }
      case "imagePicker":
        return this.pickImage({ bid: sel.start.bid, start: sel.start.off, end: sel.start.off });
      case "insertText":
        this.replaceRange(sel.start, "end" in sel && sel.end ? sel.end : sel.start, cmd.text);
        if (cmd.caret !== undefined && !cmd.text.includes("\n")) this.setCaret({ bid: sel.start.bid, off: Math.min(sel.start.off, ("end" in sel && sel.end ? sel.end.off : sel.start.off)) + cmd.caret });
        return;
      case "insertBlock":
        return this.insertBlock(b, cmd.src, cmd.caret ?? "end");
      case "embed":
        return this.insertBlock(b, `@[](${mdUrl(cmd.url)})`, "end");
      case "diagram": {
        const lang = cmd.lang ?? "mermaid";
        const starter = lang === "mermaid" ? "graph TD\n  A[Start] --> B[End]" : "";
        return this.insertBlock(b, "```" + lang + "\n" + starter + "\n```", lang.length + 4);
      }
      case "codeBlock":
      case "mathBlock":
      case "table": {
        const src =
          cmd.type === "codeBlock" ? "```\n\n```" : cmd.type === "mathBlock" ? "$$\n\n$$" : "|   |   |\n| --- | --- |\n|   |   |";
        const nb = mkBlock(src);
        const replace = b.src === "";
        this.blocks.splice(this.index(b.id) + (replace ? 0 : 1), replace ? 1 : 0, nb);
        return this.after({ bid: nb.id, off: cmd.type === "table" ? 2 : src.indexOf("\n") + 1 });
      }
    }
  }

  // ---------- document offsets (markdown string positions) ----------

  /** Each block's [start, end) in getMarkdown(). */
  docLayout(): { id: string; start: number; end: number }[] {
    const out: { id: string; start: number; end: number }[] = [];
    let at = 0;
    this.blocks.forEach((b, i) => {
      if (i > 0) at += separator(this.blocks[i - 1].src, b.src).length;
      out.push({ id: b.id, start: at, end: at + b.src.length });
      at += b.src.length;
    });
    return out;
  }

  /** Markdown offset -> (block, offset). Offsets in a separator snap to the next block. */
  offsetToPos(offset: number): { bid: string; off: number } {
    const lay = this.docLayout();
    for (const l of lay) if (offset <= l.end) return { bid: l.id, off: Math.max(0, offset - l.start) };
    const last = lay[lay.length - 1];
    return { bid: last.id, off: last.end - last.start };
  }

  posToOffset(p: { bid: string; off: number }): number {
    const l = this.docLayout().find((x) => x.id === p.bid);
    return l ? l.start + p.off : 0;
  }

  /** Markdown offsets of the current selection, or null. */
  getSelectionOffsets(): { from: number; to: number } | null {
    const sel = this.getSel();
    if (!sel) return null;
    const a = this.posToOffset(sel.start);
    const b = this.posToOffset(sel.end);
    return { from: Math.min(a, b), to: Math.max(a, b) };
  }

  /** Replace markdown [from, to) with text as ONE undoable edit. */
  replaceDoc(from: number, to: number, text: string, kind = "edit"): void {
    this.replaceRange(this.offsetToPos(from), this.offsetToPos(to), text, kind);
  }

  /** Select markdown [from, to) and scroll it into view. */
  selectDoc(from: number, to = from): void {
    const a = this.offsetToPos(from);
    const b = this.offsetToPos(to);
    this.setCaret(a, from === to ? undefined : b);
    this.els.get(a.bid)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  /** Restore a selection by markdown offsets without scrolling (overlay re-renders). */
  selectDocQuiet(from: number, to = from): void {
    const a = this.offsetToPos(from);
    const b = this.offsetToPos(to);
    const el = this.els.get(a.bid);
    const elB = this.els.get(b.bid);
    if (!el || !elB) return;
    placeCaret(el, a.off, from === to ? undefined : { el: elB, off: b.off });
  }

  /** DOM point for a markdown offset (for overlays). */
  domPointAt(offset: number): { node: Node; offset: number; block: HTMLElement } | null {
    const p = this.offsetToPos(offset);
    const el = this.els.get(p.bid);
    if (!el) return null;
    return { ...domPoint(el, p.off), block: el };
  }

  /** Markdown offset under a viewport point. */
  offsetAtPoint(x: number, y: number): number | null {
    const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
    const cp = doc.caretPositionFromPoint?.(x, y);
    let p: Pos | null = null;
    if (cp) p = posOf(this.root, cp.offsetNode, cp.offset);
    else {
      const r = document.caretRangeFromPoint?.(x, y);
      if (r) p = posOf(this.root, r.startContainer, r.startOffset);
    }
    return p ? this.posToOffset(p) : null;
  }

  /** Block element by id (for overlays). */
  blockElement(id: string): HTMLElement | undefined {
    return this.els.get(id);
  }

  private _folding?: Folding;
  /** Collapsible headings, foldable callouts and `+++` toggles (view state, never the markdown). */
  get folding(): Folding {
    return (this._folding ??= new Folding(this));
  }
  fold(id: string): void {
    this.folding.fold(id);
  }
  unfold(id: string): void {
    this.folding.unfold(id);
  }
  toggleFold(id: string): void {
    this.folding.toggle(id);
  }
  isFolded(id: string): boolean {
    return this.folding.isFolded(id);
  }
  /** Folded block ids, for hosts that persist folds. */
  getFolds(): string[] {
    return this.folding.getFolds();
  }
  setFolds(ids: string[]): void {
    this.folding.setFolds(ids);
  }
  /** The host's link-card metadata hook (EditorOptions.linkPreview). */
  get linkPreview(): LinkPreviewFn | undefined {
    return this.opts.linkPreview;
  }

  private _find?: Finder;
  /** Find & replace (Cmd/Ctrl+F). Created on first use; the shortcut works from the start. */
  get find(): Finder {
    return (this._find ??= new Finder(this));
  }

  private _ai?: AIReview;
  /** Review layer for AI collaborators (suggested edits, notes, comments, marks). Created on first use. */
  get ai(): AIReview {
    return (this._ai ??= new AIReview(this, this.opts.ai));
  }

  /** Run several edits as ONE undo step. */
  transact(fn: () => void): void {
    if (this.txDepth++ === 0) this.txPushed = false;
    try {
      fn();
    } finally {
      this.txDepth--;
    }
  }

  /** Low-level hooks used by layers such as editor.ai. Each returns an unsubscribe function. */
  onDocChange(h: (c: DocChange) => void): () => void {
    this.changeHooks.push(h);
    return () => this.changeHooks.splice(this.changeHooks.indexOf(h), 1);
  }
  onRender(h: () => void): () => void {
    this.renderHooks.push(h);
    return () => this.renderHooks.splice(this.renderHooks.indexOf(h), 1);
  }
  onKey(h: (e: KeyboardEvent) => boolean): () => void {
    this.keyHooks.push(h);
    return () => this.keyHooks.splice(this.keyHooks.indexOf(h), 1);
  }
  onPointer(h: (e: MouseEvent, offset: number | null) => boolean): () => void {
    this.pointerHooks.push(h);
    return () => this.pointerHooks.splice(this.pointerHooks.indexOf(h), 1);
  }

  // ---------- document / block API (for hosts and extensions) ----------

  /** The embed policy in effect (for widgets that build embeds). */
  get embedPolicy(): EmbedPolicy {
    return this.opts.embedPolicy ?? defaultEmbedPolicy;
  }

  /** Id of the block holding the caret, or null. */
  caretBlockId(): string | null {
    return this.getSel()?.start.bid ?? null;
  }

  /** All blocks in order, with their derived type. */
  getBlocks(): { id: string; src: string; type: BlockType }[] {
    return this.blocks.map((b) => ({ id: b.id, src: b.src, type: blockType(b.src) }));
  }

  /** Replace one block's markdown (undoable). The source may become several blocks. */
  updateBlock(id: string, src: string): void {
    const i = this.index(id);
    if (i < 0) return;
    const sel = this.getSel();
    const parts = parse(src);
    parts[0].id = id;
    this.blocks.splice(i, 1, ...parts);
    this.reconcile();
    if (sel && this.block(sel.start.bid)) this.setCaret({ bid: sel.start.bid, off: Math.min(sel.start.off, this.block(sel.start.bid)!.src.length) });
    this.commit("edit", sel?.start ?? null);
  }

  /** Document outline. */
  getHeadings(): { id: string; level: number; text: string }[] {
    return this.blocks
      .filter((b) => blockType(b.src) === "heading")
      .map((b) => ({ id: b.id, level: b.src.match(/^#+/)![0].length, text: b.src.replace(/^#+\s+/, "").replace(/[*_`~=]/g, "") }));
  }

  /** Scroll a block into view and put the caret at its end. */
  revealBlock(id: string): void {
    const el = this.els.get(id);
    if (!el) return;
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    this.root.focus();
    this.setCaret({ bid: id, off: this.block(id)!.src.length });
  }

  /** Everything known about the document: properties, outline, tasks, tags, links... (see extractMetadata). */
  getMetadata(): DocumentMetadata {
    return extractMetadata(this.getMarkdown());
  }

  /** Front matter (`---` YAML at the top) as raw text and a shallow key/value read. */
  getFrontmatter(): { raw: string; data: Record<string, string | string[]> } | null {
    const b = this.blocks[0];
    if (!b || blockType(b.src) !== "frontmatter") return null;
    return { raw: b.src.split("\n").slice(1, -1).join("\n"), data: readFrontmatter(b.src) };
  }

  /** Set (or with null, remove) the front matter YAML body. */
  setFrontmatter(yaml: string | null): void {
    const has = this.blocks[0] && blockType(this.blocks[0].src) === "frontmatter";
    if (yaml === null) {
      if (has) this.blocks.splice(0, 1);
    } else if (has) this.blocks[0].src = `---\n${yaml}\n---`;
    else this.blocks.unshift(mkBlock(`---\n${yaml}\n---`));
    if (!this.blocks.length) this.blocks.push(mkBlock(""));
    this.reconcile();
    this.commit("edit", null);
  }

  /** Re-render every block (call after registering extensions on a live editor). */
  refresh(): void {
    for (const el of this.els.values()) el._html = "";
    this.reconcile();
  }

  /** What is under the caret right now. */
  getState(): EditorState {
    const sel = this.getSel();
    const b = sel ? this.block(sel.start.bid) : undefined;
    const block = b ? blockType(b.src) : null;
    const formats = new Set<InlineFormat>();
    const el = b && this.els.get(b.id);
    if (el && sel) {
      for (const inl of el.querySelectorAll<HTMLElement>(".md-inline")) {
        const s = Number(inl.dataset.s);
        const e = Number(inl.dataset.e);
        if (s < sel.start.off && sel.start.off < e) {
          for (const c of inl.classList) if (FORMAT_CLASS[c]) formats.add(FORMAT_CLASS[c]);
        }
      }
    }
    return {
      block,
      headingLevel: block === "heading" ? b!.src.match(/^#+/)![0].length : 0,
      formats: [...formats],
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  private emitState(): void {
    if (!this.opts.onStateChange) return;
    const st = this.getState();
    const key = JSON.stringify(st);
    if (key === this.lastState) return;
    this.lastState = key;
    this.opts.onStateChange(st);
  }

  // ---------- rendering ----------

  private blockHtml(b: Block): string {
    const r = renderBlock(b.src);
    const indent = r.type === "ul" || r.type === "ol" || r.type === "task" ? indentOf(b.src) : 0;
    const box = r.type === "task" ? `<span class="md-task-box" contenteditable="false" data-tm-ui></span>` : "";
    const empty = b.src === "" ? " md-empty" : "";
    return (
      `<${r.tag} class="md-block md-${r.type}${empty}" data-bid="${b.id}" data-type="${r.type}"` +
      `${r.attrs}${indent ? ` style="--indent:${indent}"` : ""}>${box}${r.html || "<br>"}</${r.tag}>`
    );
  }

  private buildEl(b: Block, html: string): BlockEl {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const el = tpl.content.firstElementChild as BlockEl;
    el._html = html;
    // empty code / math bodies get an empty text node so the caret has somewhere to live
    for (const body of el.querySelectorAll(".md-code-block > code, .md-math-body")) {
      if (!body.firstChild) body.append(document.createTextNode(""));
    }
    return el;
  }

  /** Attach everything that adds no source text: images, embeds, widgets, inline decorations. */
  private hydrate(el: BlockEl, b: Block): void {
    if (this.opts.resolveImageUrl) {
      for (const img of el.querySelectorAll<HTMLImageElement>("img[data-src]")) img.src = this.opts.resolveImageUrl(img.dataset.src!);
    }
    for (const mount of el.querySelectorAll<HTMLElement>(".md-embed[data-embed]")) {
      mount.append(buildEmbed(mount.dataset.embed!, this.opts.embedPolicy ?? defaultEmbedPolicy));
    }
    for (const x of el.querySelectorAll<HTMLElement>(".md-x[data-ext]")) {
      const ext = registry.inline.find((i) => i.name === x.dataset.ext);
      try {
        ext?.decorate?.(x, extData(x), this);
      } catch (err) {
        console.error(err);
      }
    }
    this.mountWidget(el, b);
  }

  private mountWidget(el: BlockEl, b: Block): void {
    const mount = el.querySelector<HTMLElement>(":scope > .md-widget");
    if (!mount) return;
    const x = matchBlockExt(b.src);
    if (!x || x.ext.kind !== "widget") return;
    el._cleanup?.();
    mount.replaceChildren();
    const fence = fenceInfo(b.src);
    const lines = b.src.split("\n");
    const body = fence ? lines.slice(1, fence.closed ? -1 : undefined).join("\n") : b.src;
    try {
      const done = x.ext.render({
        el: mount,
        src: b.src,
        body,
        match: x.match,
        setSource: (next) => this.updateBlock(b.id, next),
        editor: this,
        blockId: b.id,
        readOnly: this.readOnly,
      });
      el._cleanup = typeof done === "function" ? done : undefined;
    } catch (err) {
      mount.textContent = `Widget "${x.ext.name}" failed: ${(err as Error).message}`;
    }
  }

  /** Make the DOM match the model, replacing only blocks whose HTML changed. */
  private reconcile(): void {
    const keep = new Set(this.blocks.map((b) => b.id));
    let changed = false;
    for (const [id, el] of this.els) {
      if (!keep.has(id)) {
        el._cleanup?.();
        el.remove();
        this.els.delete(id);
        changed = true;
      }
    }
    let prev: Element | null = null;
    const fresh: [BlockEl, Block][] = [];
    for (const b of this.blocks) {
      const html = this.blockHtml(b);
      let el = this.els.get(b.id);
      if (!el || el._html !== html || !el.isConnected) {
        const focused = el?.classList.contains("md-focus");
        const next = this.buildEl(b, html);
        if (el?.isConnected) {
          el._cleanup?.();
          el.replaceWith(next);
        }
        el = next;
        if (focused) el.classList.add("md-focus");
        this.els.set(b.id, el);
        fresh.push([el, b]);
        changed = true;
      }
      const want: Element | null = prev ? prev.nextElementSibling : this.root.firstElementChild;
      if (want !== el) {
        if (prev) prev.after(el);
        else this.root.prepend(el);
      }
      prev = el;
    }
    // drop anything the browser inserted that isn't a block
    while (prev && prev.nextSibling) prev.nextSibling.remove();
    for (const n of Array.from(this.root.childNodes)) {
      if (!(n as HTMLElement).dataset?.bid) n.remove();
    }
    for (const [el, b] of fresh) this.hydrate(el, b); // after insertion: widgets may measure / read the document
    if (changed) {
      // live widgets (table of contents, queries...) re-render on any document change
      for (const b of this.blocks) {
        const x = matchBlockExt(b.src);
        const el = this.els.get(b.id)!;
        if (x?.ext.kind === "widget" && x.ext.live && !fresh.some(([f]) => f === el)) this.mountWidget(el, b);
      }
    }
    this.root.classList.toggle("tm-empty", this.blocks.length === 1 && this.blocks[0].src === "");
    for (const h of this.renderHooks ?? []) h();
  }

  // ---------- caret / focus ----------

  private block(id: string): Block | undefined {
    return this.blocks.find((b) => b.id === id);
  }

  private index(id: string): number {
    return this.blocks.findIndex((b) => b.id === id);
  }

  private getSel(): { start: Pos; end: Pos; collapsed: boolean } | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    if (!this.root.contains(r.commonAncestorContainer)) return null;
    const start = posOf(this.root, r.startContainer, r.startOffset);
    const end = posOf(this.root, r.endContainer, r.endOffset);
    if (!start || !end) return null;
    return { start, end, collapsed: r.collapsed };
  }

  private setCaret(p: Pos, focusEnd?: Pos): void {
    const el = this.els.get(p.bid);
    if (!el) return;
    this.applyFocus(p);
    const endEl = focusEnd && this.els.get(focusEnd.bid);
    placeCaret(el, p.off, endEl ? { el: endEl, off: focusEnd!.off } : undefined);
  }

  /** Mark the caret block `.md-focus` and every inline touching the caret `.md-expand`. */
  private applyFocus(p: Pos | null): void {
    for (const e of this.root.querySelectorAll(".md-focus")) {
      if ((e as HTMLElement).dataset.bid !== p?.bid) e.classList.remove("md-focus");
    }
    for (const e of this.root.querySelectorAll(".md-expand")) e.classList.remove("md-expand");
    if (!p) return;
    const el = this.els.get(p.bid);
    if (!el) return;
    el.classList.add("md-focus");
    for (const inl of el.querySelectorAll<HTMLElement>(".md-inline")) {
      const s = Number(inl.dataset.s);
      const e = Number(inl.dataset.e);
      if (s <= p.off && p.off <= e) inl.classList.add("md-expand");
    }
  }

  private syncFocus(): void {
    if (this.composing || this.readOnly) return;
    if (this.suggest) {
      const sel = this.getSel();
      if (!sel || sel.start.bid !== this.suggest.bid || sel.start.off <= this.suggest.start) this.closeSuggest();
    }
    queueMicrotask(() => this.emitState());
    const sel = this.getSel();
    if (!sel) return this.applyFocus(null);
    this.applyFocus(sel.start);
    if (sel.collapsed) {
      // expanding meta can move text around; re-place caret so it stays on a visible node
      const el = this.els.get(sel.start.bid);
      const s = window.getSelection()!;
      const node = s.anchorNode?.parentElement?.closest(".md-meta");
      if (el && node && !node.closest(".md-expand") && !node.classList.contains("md-block-meta")) {
        placeCaret(el, sel.start.off);
      }
    }
  }

  // ---------- history ----------

  private snapshot(caret: Pos | null): Snapshot {
    return { blocks: this.blocks.map((b) => ({ ...b })), caret };
  }

  private commit(kind: string, caret: Pos | null): void {
    const now = Date.now();
    const coalesce = (kind === "type" && this.lastKind === "type" && now - this.lastTime < 1000) || (this.txDepth > 0 && this.txPushed);
    if (!coalesce) this.undoStack.push(this.current);
    if (this.txDepth > 0) this.txPushed = true;
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.lastKind = kind;
    this.lastTime = now;
    this.current = this.snapshot(caret);
    this.emitChange(kind);
    this.opts.onChange?.(this.lastMd);
    this.emitState();
    if (kind === "type") void this.updateSuggest();
    else this.closeSuggest();
  }

  // ---------- suggestions ----------

  private closeSuggest(): void {
    this.suggest = null;
    this.menu.hide();
  }

  private async updateSuggest(): Promise<void> {
    const sel = this.getSel();
    if (!sel || !sel.collapsed || !registry.suggesters.length) return this.closeSuggest();
    const b = this.block(sel.start.bid)!;
    if (["code", "math", "frontmatter", "html", "widget"].includes(blockType(b.src))) return this.closeSuggest();
    const before = b.src.slice(0, sel.start.off);
    let best: { sg: Suggester; idx: number; q: string } | null = null;
    for (const sg of registry.suggesters) {
      const idx = before.lastIndexOf(sg.trigger);
      if (idx < 0 || (best && idx < best.idx)) continue;
      const boundary = sg.boundary ?? sg.trigger.length === 1;
      if (boundary && idx > 0 && !/\s/.test(before[idx - 1]) && idx !== prefixLen(b.src)) continue;
      const q = before.slice(idx + sg.trigger.length);
      if (q.length > 40 || q.includes("\n") || (sg.trigger.length === 1 && /\s/.test(q))) continue;
      if (this.dismissed === `${b.id}:${idx}`) continue;
      best = { sg, idx, q };
    }
    if (!best) return this.closeSuggest();
    const token = ++this.suggestToken;
    this.suggest = { bid: b.id, start: best.idx, sg: best.sg, token };
    let items: SuggestItem[];
    try {
      items = await best.sg.items(best.q, { editor: this });
    } catch {
      items = [];
    }
    if (token !== this.suggestToken || !this.suggest) return;
    const r = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    let rect = r?.getClientRects()[0] ?? r?.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height && !rect.top)) rect = this.els.get(b.id)!.getBoundingClientRect();
    this.menu.show(items, rect);
  }

  private applySuggestion(item: SuggestItem): void {
    const ctx = this.suggest;
    const sel = this.getSel();
    this.closeSuggest();
    if (!ctx || !sel) return;
    const start = { bid: ctx.bid, off: ctx.start };
    if (typeof item.apply === "string") this.replaceRange(start, sel.start, item.apply);
    else {
      this.replaceRange(start, sel.start, "");
      item.apply({ editor: this });
    }
  }

  undo(): void {
    if (this.undoStack.length) this.announce("Undo");
    this.travel(this.undoStack, this.redoStack);
  }

  redo(): void {
    if (this.redoStack.length) this.announce("Redo");
    this.travel(this.redoStack, this.undoStack);
  }

  private travel(from: Snapshot[], to: Snapshot[]): void {
    const s = from.pop();
    if (!s) return;
    to.push(this.current);
    this.blocks = s.blocks.map((b) => ({ ...b }));
    this.current = s;
    this.lastKind = "";
    this.reconcile();
    const c = s.caret && this.block(s.caret.bid) ? s.caret : this.endOf(this.blocks[0]);
    this.setCaret(c);
    this.emitChange("undo");
    this.opts.onChange?.(this.lastMd);
  }

  /** Diff the document against the last one by common prefix/suffix and tell listeners. */
  private emitChange(kind: string): void {
    const prev = this.lastMd;
    const next = this.getMarkdown();
    this.lastMd = next;
    if (prev === next) return;
    let p = 0;
    const max = Math.min(prev.length, next.length);
    while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    let q = 0;
    while (q < max - p && prev.charCodeAt(prev.length - 1 - q) === next.charCodeAt(next.length - 1 - q)) q++;
    const ch: DocChange = { from: p, oldTo: prev.length - q, newTo: next.length - q, kind };
    for (const h of this.changeHooks) h(ch);
  }

  private endOf(b: Block): Pos {
    return { bid: b.id, off: b.src.length };
  }

  // ---------- model operations ----------

  /** Replace the raw range [start, end) (possibly spanning blocks) with text. */
  private replaceRange(start: Pos, end: Pos, text: string, kind = "edit"): void {
    let i = this.index(start.bid);
    let j = this.index(end.bid);
    if (i < 0 || j < 0) return;
    if (i > j || (i === j && start.off > end.off)) [start, end, i, j] = [end, start, j, i];
    const A = this.blocks[i];
    const suffix = this.blocks[j].src.slice(end.off);
    const merged = A.src.slice(0, start.off) + text + suffix;
    this.blocks.splice(i + 1, j - i);
    let caret: Pos;
    if (text.includes("\n") && blockType(A.src) !== "code") {
      const parts = parse(merged);
      parts[0].id = A.id;
      this.blocks.splice(i, 1, ...parts);
      const last = parts[parts.length - 1];
      caret = { bid: last.id, off: last.src.endsWith(suffix) ? last.src.length - suffix.length : last.src.length };
    } else {
      A.src = merged;
      caret = { bid: A.id, off: start.off + text.length };
    }
    this.reconcile();
    this.setCaret(caret);
    this.commit(kind, caret);
  }

  /** The `![alt]()` with an EMPTY url that contains the caret, if any. */
  private emptyImageAt(p: Pos): { start: number; end: number; alt: string } | null {
    const b = this.block(p.bid)!;
    const re = /!\[([^\]]*)\]\(\s*\)/g;
    for (let m = re.exec(b.src); m; m = re.exec(b.src)) {
      if (m.index < p.off && p.off <= m.index + m[0].length) return { start: m.index, end: m.index + m[0].length, alt: m[1] };
    }
    return null;
  }

  /** Open a file dialog and replace [start, end) of block `bid` with the uploaded image(s). */
  pickImage(at?: { bid: string; start: number; end: number; alt?: string }): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => void this.insertImages(Array.from(input.files ?? []), at ? { bid: at.bid, off: at.start } : undefined, at);
    input.click();
  }

  private enter(p: Pos): void {
    const img = this.emptyImageAt(p);
    if (img) return this.pickImage({ bid: p.bid, ...img });
    const b = this.block(p.bid)!;
    const t = blockType(b.src);
    if (t === "code" || t === "math") {
      const info = fenceInfo(b.src)!;
      if (!info.closed && b.src === info.open) {
        // "```js" or "$$" + Enter: open the block and close it for the user
        b.src = `${info.open}\n\n${info.closer}`;
        return this.after({ bid: b.id, off: info.open.length + 1 });
      }
      const closeAt = info.closed ? b.src.lastIndexOf("\n") : b.src.length;
      if (p.off > closeAt) return this.insertBlockAfter(b, "");
      return this.replaceRange(p, p, "\n");
    }
    if (t === "table") return this.tableNewRow(b, p.off);
    if (t === "paragraph" && p.off === b.src.length && /^\|(?:[^|\n]*\|){2,}\s*$/.test(b.src)) {
      // "| a | b |" + Enter: turn the header line into a table
      const n = pipesOf(b.src.trimEnd()).length - 1;
      const head = b.src.trimEnd();
      b.src = `${head}\n|${" --- |".repeat(n)}\n|${"   |".repeat(n)}`;
      const rowStart = b.src.lastIndexOf("\n") + 1;
      return this.after({ bid: b.id, off: rowStart + 2 });
    }
    const pre = prefixLen(b.src);
    if (pre > 0 && b.src.length === pre) {
      // Enter in an empty list item / quote line leaves the list
      b.src = "";
      return this.after({ bid: b.id, off: 0 });
    }
    const before = b.src.slice(0, p.off);
    const rest = b.src.slice(p.off);
    const cont = p.off >= pre ? continuation(b.src) ?? "" : "";
    if (p.off < pre) {
      // caret inside the syntax prefix: push a blank block above
      const nb = mkBlock("");
      this.blocks.splice(this.index(b.id), 0, nb);
      return this.after({ bid: b.id, off: p.off });
    }
    b.src = before;
    const nb = mkBlock(cont + rest);
    this.blocks.splice(this.index(b.id) + 1, 0, nb);
    this.after({ bid: nb.id, off: cont.length });
  }

  private lineAt(src: string, off: number): { start: number; end: number; idx: number } {
    const start = src.lastIndexOf("\n", off - 1) + 1;
    const nl = src.indexOf("\n", off);
    return { start, end: nl < 0 ? src.length : nl, idx: src.slice(0, start).split("\n").length - 1 };
  }

  /** Enter inside a table: add an empty row below the caret row. */
  private tableNewRow(b: Block, off: number): void {
    const header = b.src.split("\n", 1)[0];
    const n = Math.max(1, pipesOf(header).length - 1);
    const line = this.lineAt(b.src, off);
    const at = line.idx === 0 ? this.lineAt(b.src, line.end + 1).end : line.end; // never between header and separator
    const row = "|" + "   |".repeat(n);
    b.src = b.src.slice(0, at) + "\n" + row + b.src.slice(at);
    this.after({ bid: b.id, off: at + 3 });
  }

  /** Tab / Shift+Tab inside a table: jump to the next / previous cell. */
  private tableTab(b: Block, off: number, back: boolean): void {
    const starts: number[] = [];
    let base = 0;
    b.src.split("\n").forEach((line, i) => {
      if (i !== 1) pipesOf(line).slice(0, -1).forEach((pp) => starts.push(base + pp + 1));
      base += line.length + 1;
    });
    const cur = starts.filter((s) => s <= off).pop() ?? 0;
    let target = back ? starts.filter((s) => s < cur).pop() : starts.find((s) => s > off);
    if (target === undefined) {
      if (back) return;
      this.tableNewRow(b, b.src.length);
      return;
    }
    if (b.src[target] === " ") target++;
    this.setCaret({ bid: b.id, off: target });
  }

  /** Insert a new block after `b` (or replace `b` if it is empty); caret at `off` ("end" = end of block). */
  private insertBlock(b: Block, src: string, off: number | "end"): void {
    const nb = mkBlock(src);
    const replace = b.src === "";
    this.blocks.splice(this.index(b.id) + (replace ? 0 : 1), replace ? 1 : 0, nb);
    if (this.index(nb.id) === this.blocks.length - 1) this.blocks.push(mkBlock("")); // room to keep typing
    this.after({ bid: nb.id, off: off === "end" ? src.length : off });
  }

  /** Upload image files and insert them as markdown images at `at`. */
  async insertImages(files: File[], at?: Pos, replace?: { bid: string; start: number; end: number; alt?: string }): Promise<void> {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const upload = this.opts.uploadImage ?? fileToDataUrl;
    const urls = await Promise.all(imgs.map((f) => upload(f).catch(() => null)));
    const md = imgs
      .map((f, i) => (urls[i] ? `![${(i === 0 && replace?.alt) || altFromName(f.name)}](${mdUrl(urls[i]!)})` : ""))
      .filter(Boolean)
      .join("\n\n");
    if (!md || this.readOnly) return;
    // the document may have changed while uploading: fall back to the end
    const rb = replace && this.block(replace.bid);
    if (rb && /^!\[[^\]]*\]\(\s*\)$/.test(rb.src.slice(replace!.start, replace!.end))) {
      return this.replaceRange({ bid: replace!.bid, off: replace!.start }, { bid: replace!.bid, off: replace!.end }, md);
    }
    const pos = at && this.block(at.bid) && at.off <= this.block(at.bid)!.src.length ? at : this.endOf(this.blocks[this.blocks.length - 1]);
    this.replaceRange(pos, pos, md);
  }

  /** The caret block as typing aids see it (single-block selections only). */
  private typingCtx(sel: { start: Pos; end: Pos }): TypingCtx | null {
    const b = sel.start.bid === sel.end.bid ? this.block(sel.start.bid) : undefined;
    if (!b) return null;
    return {
      bid: b.id,
      src: b.src,
      start: Math.min(sel.start.off, sel.end.off),
      end: Math.max(sel.start.off, sel.end.off),
      set: (src, a, z, kind = "edit") => {
        b.src = src;
        this.reconcile();
        const caret = { bid: b.id, off: a };
        this.setCaret(caret, z === undefined ? undefined : { bid: b.id, off: z });
        this.commit(kind, caret);
      },
    };
  }

  private onPasteFiles(e: ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      const sel = this.getSel();
      const md = this.typing.pasteText(sel && this.typingCtx(sel), e.clipboardData);
      if (md == null || !sel) return;
      e.preventDefault();
      return this.replaceRange(sel.start, sel.end, md.replace(/\r\n?/g, "\n"));
    }
    e.preventDefault();
    const at = this.getSel()?.start;
    const img = at && this.emptyImageAt(at);
    void this.insertImages(files, at, img ? { bid: at!.bid, ...img } : undefined);
  }

  private onDropFiles(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    // caret position under the pointer
    const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
    let pos: Pos | null = null;
    const cp = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (cp) pos = posOf(this.root, cp.offsetNode, cp.offset);
    else {
      const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (r) pos = posOf(this.root, r.startContainer, r.startOffset);
    }
    void this.insertImages(files, pos ?? undefined);
  }

  private insertBlockAfter(b: Block, src: string): void {
    const nb = mkBlock(src);
    this.blocks.splice(this.index(b.id) + 1, 0, nb);
    this.after({ bid: nb.id, off: src.length });
  }

  private after(caret: Pos, kind = "edit"): void {
    this.reconcile();
    this.setCaret(caret);
    this.commit(kind, caret);
  }

  private backspaceAtStart(b: Block): void {
    const i = this.index(b.id);
    if (i === 0) return;
    const prev = this.blocks[i - 1];
    if (blockType(prev.src) === "hr") {
      this.blocks.splice(i - 1, 1);
      return this.after({ bid: b.id, off: 0 });
    }
    const off = prev.src.length;
    prev.src += b.src;
    this.blocks.splice(i, 1);
    this.after({ bid: prev.id, off });
  }

  private indent(b: Block, dir: 1 | -1): void {
    if (dir > 0) b.src = "  " + b.src;
    else if (b.src.startsWith("  ")) b.src = b.src.slice(2);
    else return;
    this.after({ bid: b.id, off: b.src.length });
  }

  private wrapSelection(mark: string): void {
    const sel = this.getSel();
    if (!sel || sel.start.bid !== sel.end.bid) return;
    const b = this.block(sel.start.bid)!;
    const [s, e] = [Math.min(sel.start.off, sel.end.off), Math.max(sel.start.off, sel.end.off)];
    const inner = b.src.slice(s, e);
    const n = mark.length;
    if (b.src.slice(s - n, s) === mark && b.src.slice(e, e + n) === mark) {
      b.src = b.src.slice(0, s - n) + inner + b.src.slice(e + n);
      this.reconcile();
      this.setCaret({ bid: b.id, off: s - n }, { bid: b.id, off: e - n });
    } else {
      b.src = b.src.slice(0, s) + mark + inner + mark + b.src.slice(e);
      this.reconcile();
      if (s === e) this.setCaret({ bid: b.id, off: s + n });
      else this.setCaret({ bid: b.id, off: s + n }, { bid: b.id, off: e + n });
    }
    this.commit("edit", { bid: b.id, off: s + n });
  }

  // ---------- events ----------

  private onBeforeInput(e: InputEvent): void {
    if (this.composing || e.isComposing) return;
    const sel = this.getSel();
    if (!sel) return;
    const { start, end, collapsed } = sel;
    const cross = start.bid !== end.bid;
    const t = e.inputType;
    const prevent = () => e.preventDefault();

    if (t === "historyUndo") return prevent(), this.undo();
    if (t === "historyRedo") return prevent(), this.redo();
    const tc = this.typingCtx(sel);
    if (tc && this.typing.handleInput(tc, e)) return;

    if (t === "insertParagraph") {
      prevent();
      if (!collapsed) {
        this.replaceRange(start, end, "");
        const s2 = this.getSel();
        if (s2) this.enter(s2.start);
        return;
      }
      return this.enter(start);
    }
    if (t === "insertLineBreak") return prevent(), this.replaceRange(start, end, "\n");

    if (t === "insertFromPaste" || t === "insertFromDrop" || t === "insertReplacementText") {
      const text = e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
      prevent();
      return this.replaceRange(start, end, text.replace(/\r\n?/g, "\n"));
    }

    if (t.startsWith("delete")) {
      const b = this.block(start.bid)!;
      if (!collapsed) return prevent(), this.replaceRange(start, end, "");
      const backward = t.includes("Backward");
      if (backward && start.off === 0) return prevent(), this.backspaceAtStart(b);
      const pre = prefixLen(b.src);
      if (backward && pre > 0 && start.off === pre && t === "deleteContentBackward") {
        // Backspace right after "# " / "- " / "> ": drop the block syntax, keep the text
        prevent();
        b.src = b.src.slice(pre);
        return this.after({ bid: b.id, off: 0 });
      }
      if (!backward && start.off === b.src.length) {
        const next = this.blocks[this.index(b.id) + 1];
        if (!next) return prevent();
        prevent();
        b.src += next.src;
        this.blocks.splice(this.index(next.id), 1);
        return this.after({ bid: b.id, off: start.off });
      }
      if (blockType(b.src) === "table") {
        // never eat a hidden pipe or row break: that would silently merge cells/rows
        const ch = backward ? b.src[start.off - 1] : b.src[start.off];
        if (ch === "|" || ch === "\n") return prevent();
      }
      if (t === "deleteContentBackward" || t === "deleteContentForward") {
        // single-char deletes go through the model so hidden syntax never gets in the way
        prevent();
        const len = backward ? charLenBefore(b.src, start.off) : charLenAfter(b.src, start.off);
        const from = backward ? start.off - len : start.off;
        return this.replaceRange({ bid: b.id, off: from }, { bid: b.id, off: from + len }, "", "type");
      }
      return; // word/line deletes inside one block: let the browser do it, onInput resyncs
    }

    if (cross || !collapsed) {
      prevent();
      return this.replaceRange(start, end, e.data ?? "", "type");
    }
    // collapsed insertText: native, picked up by onInput
  }

  private onInput(): void {
    if (this.composing) return;
    const s = window.getSelection();
    const el = s?.anchorNode ? blockElOf(s.anchorNode, this.root) : null;
    if (!el) {
      // browser broke the block structure (rare): rebuild from the DOM text
      this.blocks = parse(
        Array.from(this.root.children)
          .filter((c) => (c as HTMLElement).dataset.bid)
          .map((c) => sourceText(c as HTMLElement))
          .join("\n\n"),
      );
      this.reconcile();
      return this.commit("edit", null);
    }
    const b = this.block(el.dataset.bid!);
    if (!b) return;
    const caret = posOf(this.root, s!.anchorNode, s!.anchorOffset)!;
    const text = sourceText(el);
    if (text === b.src) return;
    b.src = text;
    this.reconcile();
    this.setCaret(caret);
    this.commit("type", caret);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.menu.open && e.key === "Escape" && this.suggest) this.dismissed = `${this.suggest.bid}:${this.suggest.start}`;
    if (this.menu.key(e)) return;
    for (const h of this.keyHooks) if (h(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z") return e.preventDefault(), e.shiftKey ? this.redo() : this.undo();
    if (mod && k === "y") return e.preventDefault(), this.redo();
    if (mod && k === "b") return e.preventDefault(), this.wrapSelection("**");
    if (mod && k === "i") return e.preventDefault(), this.wrapSelection("*");
    if (mod && k === "e") return e.preventDefault(), this.wrapSelection("`");
    if (e.key === "Tab") {
      const sel = this.getSel();
      if (!sel) return;
      const b = this.block(sel.start.bid)!;
      const t = blockType(b.src);
      e.preventDefault();
      if (t === "table") return this.tableTab(b, sel.start.off, e.shiftKey);
      if (t === "ul" || t === "ol" || t === "task") this.indent(b, e.shiftKey ? -1 : 1);
      else if (!e.shiftKey) this.replaceRange(sel.start, sel.end, t === "code" ? "  " : "\t");
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.pointerHooks.length) {
      const off = this.offsetAtPoint(e.clientX, e.clientY);
      for (const h of this.pointerHooks) if (h(e, off)) return;
    }
    const target = e.target as HTMLElement;
    if (target.classList.contains("md-task-box")) {
      e.preventDefault();
      const el = target.closest<HTMLElement>("[data-bid]")!;
      const b = this.block(el.dataset.bid!)!;
      b.src = b.src.replace(/\[([ xX])\]/, (_m, c) => (c === " " ? "[x]" : "[ ]"));
      this.reconcile();
      this.commit("edit", null);
      return;
    }
    const xel = target.closest<HTMLElement>(".md-x[data-ext]");
    if (xel) {
      const ext = registry.inline.find((i) => i.name === xel.dataset.ext);
      if (ext?.onClick && (!ext.modClick || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ext.onClick(extData(xel), { editor: this, event: e, element: xel });
        return;
      }
    }
    if (target.tagName === "IMG" && target.closest(".md-image")) {
      // click an image to edit its markdown (caret into the alt text)
      e.preventDefault();
      const inl = target.closest<HTMLElement>(".md-image")!;
      const el = target.closest<HTMLElement>("[data-bid]")!;
      this.root.focus();
      this.setCaret({ bid: el.dataset.bid!, off: Number(inl.dataset.s) + 2 });
      return;
    }
    if (
      target.tagName === "TM-PREVIEW" ||
      target.matches(".md-embed, .md-embed-note, .md-props, .md-props *") ||
      (target.matches(".md-widget") && !this.readOnly)
    ) {
      e.preventDefault();
      const el = target.closest<HTMLElement>("[data-bid]")!;
      const src = this.block(el.dataset.bid!)!.src;
      this.root.focus();
      this.setCaret({ bid: el.dataset.bid!, off: target.tagName === "TM-PREVIEW" ? src.indexOf("\n") + 1 : src.length });
      return;
    }
    if (target.tagName === "TM-MATH") {
      // click a rendered formula to edit its source
      e.preventDefault();
      const el = target.closest<HTMLElement>("[data-bid]")!;
      const inl = target.closest<HTMLElement>(".md-math");
      const off = inl ? Number(inl.dataset.s) + 1 : (this.block(el.dataset.bid!)!.src.indexOf("\n") + 1 || 2);
      this.root.focus();
      this.setCaret({ bid: el.dataset.bid!, off });
      return;
    }
    const fn = target.closest<HTMLElement>(".md-fn-ref");
    if (fn && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const def = this.root.querySelector<HTMLElement>(`[data-type="footnote"][data-fn="${CSS.escape(fn.dataset.fn!)}"]`);
      if (def) {
        def.scrollIntoView?.({ block: "center", behavior: "smooth" });
        this.setCaret({ bid: def.dataset.bid!, off: this.block(def.dataset.bid!)!.src.length });
      }
      return;
    }
    const a = target.closest("a");
    if (a && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      window.open(a.getAttribute("href") ?? "#", "_blank", "noopener");
    }
  }

  /** Copy as markdown source, not rendered HTML. */
  private onCopy(e: ClipboardEvent, cut: boolean): void {
    const sel = this.getSel();
    if (!sel || sel.collapsed) return;
    let { start, end } = sel;
    let i = this.index(start.bid);
    let j = this.index(end.bid);
    if (i > j) [start, end, i, j] = [end, start, j, i];
    let md: string;
    if (i === j) md = this.blocks[i].src.slice(start.off, end.off);
    else {
      const mid = this.blocks.slice(i + 1, j).map((b) => b.src);
      md = serialize(
        [this.blocks[i].src.slice(start.off), ...mid, this.blocks[j].src.slice(0, end.off)].map((src) => ({ id: "", src })),
      );
    }
    e.clipboardData?.setData("text/plain", md);
    e.preventDefault();
    if (cut) this.replaceRange(start, end, "");
  }
}

function charLenBefore(s: string, off: number): number {
  if (off <= 0) return 0;
  const c = s.charCodeAt(off - 1);
  return c >= 0xdc00 && c <= 0xdfff && off >= 2 ? 2 : 1;
}

function charLenAfter(s: string, off: number): number {
  if (off >= s.length) return 0;
  const c = s.charCodeAt(off);
  return c >= 0xd800 && c <= 0xdbff ? 2 : 1;
}

export function createEditor(root: HTMLElement, opts?: EditorOptions): Editor {
  return new Editor(root, opts);
}
