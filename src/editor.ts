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
import { Block, blockType, continuation, fenceInfo, indentOf, mkBlock, parse, pipesOf, prefixLen, renderBlock, serialize } from "./block";
import "./math";
import { Pos, blockElOf, placeCaret, posOf } from "./caret";

export interface EditorOptions {
  value?: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
}

interface Snapshot {
  blocks: Block[];
  caret: Pos | null;
}

type BlockEl = HTMLElement & { _html?: string };

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
  private onSel = () => this.syncFocus();

  constructor(root: HTMLElement, opts: EditorOptions = {}) {
    this.root = root;
    this.opts = opts;
    root.classList.add("tm-editor");
    root.contentEditable = "true";
    root.spellcheck = true;
    if (opts.placeholder) root.dataset.placeholder = opts.placeholder;
    this.setMarkdown(opts.value ?? "");
    root.addEventListener("beforeinput", (e) => this.onBeforeInput(e as InputEvent));
    root.addEventListener("input", () => this.onInput());
    root.addEventListener("keydown", (e) => this.onKeyDown(e));
    root.addEventListener("compositionstart", () => (this.composing = true));
    root.addEventListener("compositionend", () => {
      this.composing = false;
      this.onInput();
    });
    root.addEventListener("copy", (e) => this.onCopy(e, false));
    root.addEventListener("cut", (e) => this.onCopy(e, true));
    root.addEventListener("mousedown", (e) => this.onMouseDown(e));
    document.addEventListener("selectionchange", this.onSel);
  }

  destroy(): void {
    document.removeEventListener("selectionchange", this.onSel);
    this.root.contentEditable = "false";
  }

  // ---------- public API ----------

  getMarkdown(): string {
    return serialize(this.blocks);
  }

  setMarkdown(md: string): void {
    this.blocks = parse(md);
    this.root.innerHTML = "";
    this.els.clear();
    this.reconcile();
    this.current = this.snapshot(null);
    this.undoStack = [];
    this.redoStack = [];
  }

  focus(): void {
    const last = this.blocks[this.blocks.length - 1];
    this.setCaret({ bid: last.id, off: last.src.length });
  }

  // ---------- rendering ----------

  private buildEl(b: Block): BlockEl {
    const r = renderBlock(b.src);
    const tpl = document.createElement("template");
    const indent = r.type === "ul" || r.type === "ol" || r.type === "task" ? indentOf(b.src) : 0;
    const box = r.type === "task" ? `<span class="md-task-box" contenteditable="false"></span>` : "";
    const empty = b.src === "" ? " md-empty" : "";
    tpl.innerHTML =
      `<${r.tag} class="md-block md-${r.type}${empty}" data-bid="${b.id}" data-type="${r.type}"` +
      `${r.attrs}${indent ? ` style="--indent:${indent}"` : ""}>${box}${r.html || "<br>"}</${r.tag}>`;
    const el = tpl.content.firstElementChild as BlockEl;
    el._html = tpl.innerHTML;
    // empty code / math bodies get an empty text node so the caret has somewhere to live
    for (const body of el.querySelectorAll(".md-code-block > code, .md-math-body")) {
      if (!body.firstChild) body.append(document.createTextNode(""));
    }
    return el;
  }

  /** Make the DOM match the model, replacing only blocks whose HTML changed. */
  private reconcile(): void {
    const keep = new Set(this.blocks.map((b) => b.id));
    for (const [id, el] of this.els) {
      if (!keep.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
    let prev: Element | null = null;
    for (const b of this.blocks) {
      const fresh = this.buildEl(b);
      let el = this.els.get(b.id);
      if (!el || el._html !== fresh._html || !el.isConnected) {
        const focused = el?.classList.contains("md-focus");
        if (el?.isConnected) el.replaceWith(fresh);
        el = fresh;
        if (focused) el.classList.add("md-focus");
        this.els.set(b.id, el);
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
    this.root.classList.toggle("tm-empty", this.blocks.length === 1 && this.blocks[0].src === "");
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
    if (this.composing) return;
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
    const coalesce = kind === "type" && this.lastKind === "type" && now - this.lastTime < 1000;
    if (!coalesce) this.undoStack.push(this.current);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.lastKind = kind;
    this.lastTime = now;
    this.current = this.snapshot(caret);
    this.opts.onChange?.(this.getMarkdown());
  }

  undo(): void {
    this.travel(this.undoStack, this.redoStack);
  }

  redo(): void {
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
    this.opts.onChange?.(this.getMarkdown());
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

  private enter(p: Pos): void {
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
      this.blocks = parse(Array.from(this.root.children).map((c) => c.textContent ?? "").join("\n\n"));
      this.reconcile();
      return this.commit("edit", null);
    }
    const b = this.block(el.dataset.bid!);
    if (!b) return;
    const caret = posOf(this.root, s!.anchorNode, s!.anchorOffset)!;
    const text = el.textContent ?? "";
    if (text === b.src) return;
    b.src = text;
    this.reconcile();
    this.setCaret(caret);
    this.commit("type", caret);
  }

  private onKeyDown(e: KeyboardEvent): void {
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
        def.scrollIntoView({ block: "center", behavior: "smooth" });
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
