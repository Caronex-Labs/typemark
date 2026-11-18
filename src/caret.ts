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

/** UI subtrees (widgets, embeds, property panels) hold no markdown source. */
const UI = "[data-tm-ui]";
const inUi = (n: Node, blockEl: HTMLElement) => {
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
  const ui = el?.closest(UI);
  return !!ui && blockEl.contains(ui);
};

function sourceTextNodes(blockEl: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n.nodeType === 1 ? ((n as Element).matches(UI) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** The block's markdown source: its text, minus UI subtrees. */
export function sourceText(blockEl: HTMLElement): string {
  return sourceTextNodes(blockEl)
    .map((t) => t.data)
    .join("");
}

/** Raw offset of (node, offset) inside blockEl. */
export function rawOffset(blockEl: HTMLElement, node: Node, offset: number): number {
  if (inUi(node, blockEl)) return 0;
  const r = document.createRange();
  r.setStart(blockEl, 0);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0;
  }
  let acc = 0;
  for (const t of sourceTextNodes(blockEl)) {
    if (t === node) return acc + offset;
    // text nodes come in document order: count each one that ends at or before the point
    if (r.comparePoint(t, t.length) !== 0) break;
    acc += t.length;
  }
  return acc;
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
  if (blockEl.closest(".tm-source-mode")) return true; // source mode: every character is on screen
  if (metaEl.classList.contains("md-pipe")) return false;
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
  let acc = 0;
  let fallback: { node: Node; offset: number } | null = null;
  for (const t of sourceTextNodes(blockEl)) {
    const len = t.data.length;
    if (off >= acc && off <= acc + len) {
      const p = { node: t, offset: off - acc };
      // a caret right after "\n" belongs to the NEXT line's node, not the end of this one
      const afterNewline = off - acc === len && len > 0 && t.data.endsWith("\n");
      if (isVisible(t, blockEl) && !afterNewline) return p;
      fallback ??= p;
    }
    acc += len;
  }
  if (fallback) return fallback;
  // empty block (only a <br>) or offset past the end
  return { node: blockEl, offset: off === 0 ? 0 : blockEl.childNodes.length };
}
