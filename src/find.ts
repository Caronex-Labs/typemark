/**
 * Find & replace over the MARKDOWN source (matches never split syntax).
 * Highlights use the CSS Custom Highlight API (no DOM changes).
 * UI: Cmd/Ctrl+F (find), Cmd/Ctrl+Alt+F (find + replace), Enter / Shift+Enter, Esc.
 */
import type { Editor } from "./editor";

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface FindMatch {
  from: number;
  to: number;
  text: string;
}

const hasHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Finder {
  private query = "";
  private o: FindOptions = {};
  private list: FindMatch[] = [];
  private current = -1;
  private panel: HTMLDivElement | null = null;
  private error = "";

  constructor(private editor: Editor) {
    editor.onKey((e) => this.key(e));
    editor.onDocChange(() => this.search(false));
    editor.onRender(() => this.paint());
  }

  // ------------------------------------------------------------ API

  /** Set the query and options; returns the matches. */
  setQuery(query: string, o: FindOptions = this.o): FindMatch[] {
    this.query = query;
    this.o = { ...o };
    this.search(true);
    return this.matches();
  }

  matches(): FindMatch[] {
    return this.list.map((m) => ({ ...m }));
  }

  /** Index of the current match (-1 when none). */
  get index(): number {
    return this.current;
  }

  next(dir: 1 | -1 = 1): FindMatch | null {
    if (!this.list.length) return null;
    this.current = (this.current + dir + this.list.length) % this.list.length;
    this.reveal();
    return this.list[this.current];
  }

  /** Replace the current match (supports $1 groups in regex mode) and move to the next. */
  replace(replacement: string): void {
    const m = this.list[this.current];
    if (!m) return;
    const keep = this.current;
    this.editor.replaceDoc(m.from, m.to, this.expand(m, replacement));
    this.search(false);
    this.current = Math.min(keep, this.list.length - 1);
    if (this.current >= 0) this.reveal();
    this.syncPanel();
  }

  /** Replace every match as ONE undo step. Returns the count. */
  replaceAll(replacement: string): number {
    const all = [...this.list].sort((a, b) => b.from - a.from);
    this.editor.transact(() => {
      for (const m of all) this.editor.replaceDoc(m.from, m.to, this.expand(m, replacement));
    });
    this.search(false);
    this.syncPanel();
    return all.length;
  }

  /** Open the panel (optionally with replace visible). Prefills from the selection. */
  open(withReplace = false): void {
    const sel = this.editor.getSelectionOffsets();
    const md = this.editor.getMarkdown();
    const picked = sel && sel.to > sel.from && sel.to - sel.from < 200 ? md.slice(sel.from, sel.to) : "";
    this.ensurePanel();
    const p = this.panel!;
    p.hidden = false;
    // inherit the editor's theme (the panel lives in <body>)
    const cs = getComputedStyle(this.editor.root);
    for (const v of ["--tm-fg", "--tm-bg", "--tm-meta", "--tm-accent", "--tm-border"]) p.style.setProperty(v, cs.getPropertyValue(v));
    p.classList.toggle("tm-find-replace", withReplace || p.classList.contains("tm-find-replace"));
    const input = p.querySelector<HTMLInputElement>(".tm-find-q")!;
    if (picked && !picked.includes("\n")) input.value = picked;
    this.setQuery(input.value, this.o);
    input.focus();
    input.select();
  }

  close(): void {
    if (this.panel) this.panel.hidden = true;
    this.query = "";
    this.list = [];
    this.current = -1;
    this.paint();
    this.editor.root.focus();
  }

  destroy(): void {
    this.panel?.remove();
    if (hasHighlights()) {
      CSS.highlights.delete("tm-find");
      CSS.highlights.delete("tm-find-current");
    }
  }

  // ------------------------------------------------------------ internals

  private build(): RegExp | null {
    if (!this.query) return null;
    let src = this.o.regex ? this.query : escRe(this.query);
    if (this.o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    try {
      this.error = "";
      return new RegExp(src, `gu${this.o.caseSensitive ? "" : "i"}`);
    } catch (e) {
      this.error = (e as Error).message;
      return null;
    }
  }

  private search(resetCurrent: boolean): void {
    const re = this.build();
    const md = this.editor.getMarkdown();
    const prev = this.list[this.current]?.from ?? this.editor.getSelectionOffsets()?.from ?? 0;
    this.list = [];
    if (re) {
      for (let m = re.exec(md); m; m = re.exec(md)) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        this.list.push({ from: m.index, to: m.index + m[0].length, text: m[0] });
        if (this.list.length >= 10_000) break;
      }
    }
    // keep the current match near where it was (or at the caret on a new search)
    const i = this.list.findIndex((m) => m.from >= prev);
    this.current = this.list.length ? (i < 0 ? 0 : i) : -1;
    if (resetCurrent && this.current >= 0) this.reveal();
    else this.paint();
    this.syncPanel();
  }

  private expand(m: FindMatch, replacement: string): string {
    if (!this.o.regex) return replacement;
    const re = this.build()!;
    return m.text.replace(new RegExp(re.source, re.flags.replace("g", "")), replacement);
  }

  private reveal(): void {
    const m = this.list[this.current];
    if (!m) return;
    const pt = this.editor.domPointAt(m.from);
    pt?.block.scrollIntoView?.({ block: "center", behavior: "smooth" });
    this.paint();
    this.syncPanel();
  }

  private range(from: number, to: number): Range | null {
    const a = this.editor.domPointAt(from);
    const b = this.editor.domPointAt(to);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      return r;
    } catch {
      return null;
    }
  }

  private paint(): void {
    if (!hasHighlights()) return;
    const all: Range[] = [];
    const cur: Range[] = [];
    this.list.forEach((m, i) => {
      if (all.length > 2000 && i !== this.current) return;
      const r = this.range(m.from, m.to);
      if (r) (i === this.current ? cur : all).push(r);
    });
    CSS.highlights.set("tm-find", new Highlight(...all));
    CSS.highlights.set("tm-find-current", new Highlight(...cur));
  }

  private key(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "f" || e.key === "F" || e.code === "KeyF")) {
      e.preventDefault();
      this.open(e.altKey);
      return true;
    }
    if (mod && (e.key === "g" || e.code === "KeyG") && this.query) {
      e.preventDefault();
      this.next(e.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  }

  private ensurePanel(): void {
    if (this.panel?.isConnected) return;
    const p = document.createElement("div");
    p.className = "tm-find";
    p.setAttribute("role", "search");
    p.setAttribute("aria-label", "Find and replace");
    p.hidden = true;
    p.innerHTML = `
      <div class="tm-find-row">
        <button type="button" class="tm-find-toggle" aria-label="Toggle replace" title="Toggle replace (Cmd/Ctrl+Alt+F)">›</button>
        <input class="tm-find-q" type="text" placeholder="Find" aria-label="Find" spellcheck="false">
        <span class="tm-find-count" aria-live="polite"></span>
        <button type="button" data-opt="caseSensitive" aria-pressed="false" title="Match case" aria-label="Match case">Aa</button>
        <button type="button" data-opt="wholeWord" aria-pressed="false" title="Whole word" aria-label="Whole word"><u>ab</u></button>
        <button type="button" data-opt="regex" aria-pressed="false" title="Regular expression" aria-label="Regular expression">.*</button>
        <button type="button" data-act="prev" title="Previous (Shift+Enter)" aria-label="Previous match">↑</button>
        <button type="button" data-act="next" title="Next (Enter)" aria-label="Next match">↓</button>
        <button type="button" data-act="close" title="Close (Esc)" aria-label="Close find">✕</button>
      </div>
      <div class="tm-find-row tm-find-rrow">
        <span class="tm-find-spacer"></span>
        <input class="tm-find-r" type="text" placeholder="Replace" aria-label="Replace with" spellcheck="false">
        <button type="button" data-act="replace" title="Replace (Enter)">Replace</button>
        <button type="button" data-act="all" title="Replace all (Cmd/Ctrl+Enter)">All</button>
      </div>`;
    const q = p.querySelector<HTMLInputElement>(".tm-find-q")!;
    const r = p.querySelector<HTMLInputElement>(".tm-find-r")!;
    q.addEventListener("input", () => this.setQuery(q.value, this.o));
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault(), this.next(e.shiftKey ? -1 : 1);
      else if (e.key === "Escape") e.preventDefault(), this.close();
    });
    r.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(), this.replaceAll(r.value);
      else if (e.key === "Enter") e.preventDefault(), this.replace(r.value);
      else if (e.key === "Escape") e.preventDefault(), this.close();
    });
    p.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      const opt = b.dataset.opt as keyof FindOptions | undefined;
      if (opt) {
        this.o[opt] = !this.o[opt];
        b.setAttribute("aria-pressed", String(!!this.o[opt]));
        this.setQuery(q.value, this.o);
        q.focus();
      } else if (b.classList.contains("tm-find-toggle")) {
        p.classList.toggle("tm-find-replace");
        b.setAttribute("aria-expanded", String(p.classList.contains("tm-find-replace")));
      } else if (b.dataset.act === "prev") this.next(-1);
      else if (b.dataset.act === "next") this.next(1);
      else if (b.dataset.act === "close") this.close();
      else if (b.dataset.act === "replace") this.replace(r.value);
      else if (b.dataset.act === "all") this.replaceAll(r.value);
    });
    // stop the editor's handlers from seeing panel typing
    for (const ev of ["beforeinput", "input", "keydown", "paste", "mousedown"]) p.addEventListener(ev, (e) => e.stopPropagation());
    document.body.append(p);
    this.panel = p;
  }

  private syncPanel(): void {
    const c = this.panel?.querySelector(".tm-find-count");
    if (!c) return;
    c.textContent = this.error ? "invalid" : !this.query ? "" : this.list.length ? `${this.current + 1} of ${this.list.length}` : "No results";
    this.panel!.classList.toggle("tm-find-none", !!this.query && !this.list.length);
  }
}
