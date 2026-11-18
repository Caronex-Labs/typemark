/**
 * Folding: collapsible headings, Obsidian foldable callouts and `+++` toggle blocks.
 *
 * Folding is VIEW state (keyed by block id); it never changes the markdown. The only
 * syntax that carries fold state is the callout marker: `> [!note]- T` starts collapsed,
 * `> [!note]+ T` starts expanded. Clicking a chevron toggles the view only.
 *
 * Hidden blocks stay in the DOM with the class `tm-fold-hidden` (display:none), so
 * source mapping, find and undo keep working on the full document.
 *
 * Toggle blocks (★):
 *   +++ Title
 *   any markdown blocks (the body)
 *   +++
 */
import type { Editor } from "./editor";
import type { Extension } from "./extension";
import { matchBlockExt } from "./extension";
import { blockType } from "./block";

export const TOGGLE_OPEN = /^\+\+\+ /;
export const TOGGLE_CLOSE = /^\+\+\+$/;

export const toggleExtension: Extension = {
  name: "toggle",
  blocks: [
    {
      kind: "prefix",
      name: "toggle",
      prefix: /^\+\+\+(?: |$)/,
      data: (src) => ({ toggle: TOGGLE_CLOSE.test(src) ? "end" : "open" }),
      continuation: () => null,
    },
  ],
};

type Kind = "heading" | "callout" | "toggle";
interface Info {
  kind: Kind;
  level: number;
}

function classify(src: string): Info | null {
  const t = blockType(src);
  if (t === "heading") return { kind: "heading", level: src.match(/^#+/)![0].length };
  if (t === "custom") {
    const name = matchBlockExt(src)?.ext.name;
    if (name === "callout") return { kind: "callout", level: 0 };
    if (name === "toggle" && TOGGLE_OPEN.test(src)) return { kind: "toggle", level: 0 };
  }
  return null;
}

const calloutMarker = (src: string) => src.match(/^> ?\[!\w+\]([+-]?)/)?.[1] ?? "";

/** Indices [i+1, end) that folding block i hides. */
export function foldRange(blocks: { src: string }[], i: number): [number, number] {
  const info = classify(blocks[i].src);
  let j = i + 1;
  if (!info) return [j, j];
  if (info.kind === "heading") {
    while (j < blocks.length) {
      const x = classify(blocks[j].src);
      if (x?.kind === "heading" && x.level <= info.level) break;
      j++;
    }
  } else if (info.kind === "callout") {
    while (j < blocks.length && blockType(blocks[j].src) === "quote") j++;
  } else {
    let depth = 1;
    for (; j < blocks.length; j++) {
      const s = blocks[j].src;
      if (TOGGLE_OPEN.test(s) && blockType(s) === "custom") depth++;
      else if (TOGGLE_CLOSE.test(s) && blockType(s) === "custom" && --depth === 0) {
        j++;
        break;
      }
    }
  }
  return [i + 1, j];
}

export class Folding {
  private folded = new Set<string>();
  /** Callout ids -> last seen marker, so `-` / `+` only set the INITIAL state. */
  private markers = new Map<string, string>();
  private off: (() => void)[] = [];

  constructor(private editor: Editor) {
    this.off.push(editor.onRender(() => this.apply()));
    this.off.push(editor.onPointer((e) => this.onPointer(e)));
    this.off.push(editor.onKey((e) => this.onKey(e)));
    this.apply();
  }

  destroy(): void {
    for (const f of this.off) f();
  }

  isFoldable(id: string): boolean {
    const b = this.editor.getBlocks().find((x) => x.id === id);
    return !!b && !!classify(b.src);
  }

  isFolded(id: string): boolean {
    return this.folded.has(id);
  }

  fold(id: string): void {
    if (!this.isFoldable(id) || this.folded.has(id)) return;
    this.folded.add(id);
    this.apply();
  }

  unfold(id: string): void {
    if (this.folded.delete(id)) this.apply();
  }

  toggle(id: string): void {
    if (this.folded.has(id)) this.unfold(id);
    else this.fold(id);
  }

  getFolds(): string[] {
    return [...this.folded];
  }

  setFolds(ids: string[]): void {
    this.folded = new Set(ids.filter((id) => this.isFoldable(id)));
    this.apply();
  }

  /** Is block `id` hidden by some fold? */
  isHidden(id: string): boolean {
    return !!this.editor.blockElement(id)?.classList.contains("tm-fold-hidden");
  }

  private apply(): void {
    const blocks = this.editor.getBlocks();
    const ids = new Set(blocks.map((b) => b.id));
    for (const id of this.folded) if (!ids.has(id)) this.folded.delete(id);
    const hidden = new Set<string>();
    blocks.forEach((b, i) => {
      const info = classify(b.src);
      if (info?.kind === "callout") {
        const m = calloutMarker(b.src);
        if (this.markers.get(b.id) !== m) {
          if (m === "-") this.folded.add(b.id);
          else if (this.markers.has(b.id) || m === "+") this.folded.delete(b.id);
          this.markers.set(b.id, m);
        }
      } else if (!info) this.folded.delete(b.id);
      if (!info || !this.folded.has(b.id) || hidden.has(b.id)) return;
      const [s, e] = foldRange(blocks, i);
      for (let k = s; k < e; k++) hidden.add(blocks[k].id);
    });
    for (const id of this.markers.keys()) if (!ids.has(id)) this.markers.delete(id);
    for (const b of blocks) {
      const el = this.editor.blockElement(b.id);
      if (!el) continue;
      const foldable = !!classify(b.src);
      let chev = el.querySelector<HTMLElement>(":scope > .tm-fold-chevron");
      if (foldable && !chev) {
        chev = document.createElement("span");
        chev.className = "tm-fold-chevron";
        chev.contentEditable = "false";
        chev.dataset.tmUi = "";
        chev.setAttribute("role", "button");
        chev.setAttribute("aria-label", "Toggle section");
        el.prepend(chev);
      } else if (!foldable && chev) chev.remove();
      chev?.setAttribute("aria-expanded", String(!this.folded.has(b.id)));
      el.classList.toggle("tm-foldable", foldable);
      el.classList.toggle("tm-folded", foldable && this.folded.has(b.id));
      el.classList.toggle("tm-fold-hidden", hidden.has(b.id));
    }
    // never leave the caret inside a hidden block: move it to the end of the fold header
    const cid = this.editor.caretBlockId();
    if (cid && hidden.has(cid)) {
      const idx = blocks.findIndex((b) => b.id === cid);
      for (let k = idx - 1; k >= 0; k--) {
        if (!hidden.has(blocks[k].id)) {
          const lay = this.editor.docLayout().find((l) => l.id === blocks[k].id)!;
          this.editor.selectDocQuiet(lay.end);
          break;
        }
      }
    }
  }

  private onPointer(e: MouseEvent): boolean {
    const chev = (e.target as HTMLElement).closest?.(".tm-fold-chevron");
    if (!chev) return false;
    e.preventDefault();
    const el = chev.closest<HTMLElement>("[data-bid]");
    if (el) this.toggle(el.dataset.bid!);
    return true;
  }

  /** The fold header the caret is on, or the nearest one above it. */
  private headerAtCaret(): string | null {
    const cid = this.editor.caretBlockId();
    if (!cid) return null;
    const blocks = this.editor.getBlocks();
    for (let k = blocks.findIndex((b) => b.id === cid); k >= 0; k--) {
      if (!classify(blocks[k].src)) continue;
      const [, end] = foldRange(blocks, k);
      if (blocks[k].id === cid || blocks.findIndex((b) => b.id === cid) < end) return blocks[k].id;
    }
    return null;
  }

  private onKey(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && (e.key === "[" || e.key === "]" || e.code === "BracketLeft" || e.code === "BracketRight")) {
      const id = this.headerAtCaret();
      if (!id) return false;
      e.preventDefault();
      if (e.key === "[" || e.code === "BracketLeft") {
        this.fold(id);
        const lay = this.editor.docLayout().find((l) => l.id === id)!;
        this.editor.selectDocQuiet(lay.end);
      } else this.unfold(id);
      return true;
    }
    if (e.key !== "Enter" || e.shiftKey || mod || e.altKey || e.isComposing) return false;
    const off = this.editor.getSelectionOffsets();
    const cid = this.editor.caretBlockId();
    if (!off || off.from !== off.to || !cid) return false;
    const blocks = this.editor.getBlocks();
    const i = blocks.findIndex((b) => b.id === cid);
    const b = blocks[i];
    const lay = this.editor.docLayout()[i];
    const atEnd = off.from === lay.end;
    // Enter at the end of a folded header: open it so the new block is visible
    if (atEnd && this.folded.has(cid)) this.unfold(cid);
    if (blockType(b.src) !== "custom" || matchBlockExt(b.src)?.ext.name !== "toggle") return false;
    if (TOGGLE_CLOSE.test(b.src)) {
      // Enter on a closing `+++`: a paragraph after the toggle (never erase the fence)
      if (off.from > lay.start) {
        e.preventDefault();
        this.editor.exec({ type: "insertBlock", src: "" });
        return true;
      }
      return false;
    }
    if (atEnd && foldRange(blocks, i)[1] === blocks.length && !blocks.slice(i + 1).some((x) => TOGGLE_CLOSE.test(x.src))) {
      // `+++ Title` + Enter with no closing fence: add the fence and put the caret in the body
      e.preventDefault();
      this.editor.transact(() => {
        this.editor.exec({ type: "insertBlock", src: "+++" });
        this.editor.selectDocQuiet(lay.end);
        this.editor.exec({ type: "insertBlock", src: "" });
      });
      return true;
    }
    return false;
  }
}
