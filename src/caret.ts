/**
 * Caret <-> raw-offset mapping.
 *
 * Because rendered blocks keep every markdown character in the DOM
 * (`textContent === src`), a caret position is fully described by
 * (block id, raw character offset). Re-rendering a block can therefore
 * throw away its DOM and still put the caret back in the same place.
 */

export interface Pos {
  bid: string;
  off: number;
}

export function blockElOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === 1 && (n as HTMLElement).dataset?.bid && n.parentNode === root) return n as HTMLElement;
    n = n.parentNode;
  }
  return null;
}

/** Raw offset of (node, offset) inside blockEl. */
export function rawOffset(blockEl: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(blockEl, 0);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0;
  }
  return r.toString().length;
}

export function posOf(root: HTMLElement, node: Node | null, offset: number): Pos | null {
  if (!node) return null;
  // caret on the root itself, between blocks
  if (node === root) {
    const el = (root.childNodes[offset] || root.lastChild) as HTMLElement | null;
    if (!el?.dataset?.bid) return null;
    return { bid: el.dataset.bid, off: root.childNodes[offset] ? 0 : (el.textContent || "").length };
  }
  const el = blockElOf(node, root);
  if (!el) return null;
  return { bid: el.dataset.bid!, off: rawOffset(el, node, offset) };
}

/** A text node is "visible" unless it sits in a hidden md-meta span. */
function isVisible(t: Text, blockEl: HTMLElement): boolean {
  const metaEl = t.parentElement?.closest(".md-meta");
  if (!metaEl || !blockEl.contains(metaEl)) return true;
  if (metaEl.classList.contains("md-block-meta")) return blockEl.classList.contains("md-focus");
  return !!metaEl.closest(".md-expand");
}

/** Place the DOM caret at raw offset `off` inside blockEl, preferring visible text. */
export function placeCaret(blockEl: HTMLElement, off: number, focusOff?: { el: HTMLElement; off: number }): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = domPoint(blockEl, off);
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  if (focusOff) {
    const b = domPoint(focusOff.el, focusOff.off);
    r.setEnd(b.node, b.offset);
  } else r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

export function domPoint(blockEl: HTMLElement, off: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let fallback: { node: Node; offset: number } | null = null;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    const len = t.data.length;
    if (off >= acc && off <= acc + len) {
      const p = { node: t, offset: off - acc };
      if (isVisible(t, blockEl)) return p;
      fallback ??= p;
    }
    acc += len;
  }
  if (fallback) return fallback;
  // empty block (only a <br>) or offset past the end
  return { node: blockEl, offset: off === 0 ? 0 : blockEl.childNodes.length };
}
