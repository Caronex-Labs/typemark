/** Suggestion popup (slash menu, [[ / @ / # autocomplete). Items come from Suggesters; this only draws and navigates. */
import type { SuggestItem } from "./extension";

export class SuggestMenu {
  private el: HTMLDivElement;
  private items: SuggestItem[] = [];
  private active = 0;
  onChoose: (item: SuggestItem) => void = () => {};

  constructor(private host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "tm-suggest";
    this.el.setAttribute("role", "listbox");
    this.el.hidden = true;
    // keep focus (and the caret) in the editor while clicking items
    this.el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (row) this.onChoose(this.items[Number(row.dataset.i)]);
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(items: SuggestItem[], rect: DOMRect): void {
    if (!items.length) return this.hide();
    if (!this.el.isConnected) document.body.append(this.el);
    // inherit the editor's theme variables
    const cs = getComputedStyle(this.host);
    for (const v of ["--tm-fg", "--tm-bg", "--tm-meta", "--tm-accent", "--tm-code-bg", "--tm-border"]) {
      this.el.style.setProperty(v, cs.getPropertyValue(v));
    }
    this.items = items.slice(0, 50);
    this.active = 0;
    this.render();
    this.el.hidden = false;
    const h = this.el.offsetHeight;
    const below = rect.bottom + 6 + h < innerHeight;
    this.el.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - this.el.offsetWidth - 8)) + scrollX}px`;
    this.el.style.top = `${(below ? rect.bottom + 6 : rect.top - h - 6) + scrollY}px`;
  }

  hide(): void {
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }

  /** Returns true when the key was consumed. */
  key(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) this.move(1);
    else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) this.move(-1);
    else if (e.key === "Enter" || e.key === "Tab") this.onChoose(this.items[this.active]);
    else if (e.key === "Escape") this.hide();
    else return false;
    e.preventDefault();
    return true;
  }

  private move(d: number): void {
    this.active = (this.active + d + this.items.length) % this.items.length;
    this.render();
    this.el.querySelector(".tm-suggest-active")?.scrollIntoView?.({ block: "nearest" });
  }

  private render(): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    this.el.innerHTML = this.items
      .map(
        (it, i) =>
          `<div class="tm-suggest-item${i === this.active ? " tm-suggest-active" : ""}" role="option" data-i="${i}">` +
          `<span class="tm-suggest-icon">${esc(it.icon ?? "")}</span>` +
          `<span class="tm-suggest-label">${esc(it.label)}</span>` +
          (it.detail ? `<span class="tm-suggest-detail">${esc(it.detail)}</span>` : "") +
          `</div>`,
      )
      .join("");
  }
}

/** Case-insensitive subsequence match, label first then keywords. */
export function fuzzy(items: SuggestItem[], query: string): SuggestItem[] {
  const q = query.toLowerCase();
  if (!q) return items;
  const score = (s: string) => {
    s = s.toLowerCase();
    if (s.startsWith(q)) return 3;
    if (s.includes(q)) return 2;
    let i = 0;
    for (const c of s) if (c === q[i]) i++;
    return i === q.length ? 1 : 0;
  };
  return items
    .map((it) => ({ it, s: Math.max(score(it.label) * 2, score(it.keywords ?? "")) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}
