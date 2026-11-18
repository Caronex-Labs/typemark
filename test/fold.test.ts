import { describe, expect, it } from "vitest";
import { createEditor, parse, serialize } from "../src/index";
import { sourceText } from "../src/caret";

const mount = (value: string) => {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, ed: createEditor(el, { value }) };
};
const hidden = (el: HTMLElement) =>
  [...el.children].filter((c) => c.classList.contains("tm-fold-hidden")).map((c) => sourceText(c as HTMLElement));
const key = (el: HTMLElement, init: KeyboardEventInit) => el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
const caretIn = (el: HTMLElement, off: number) => {
  const r = document.createRange();
  const t = el.querySelector(".md-block-meta")?.nextSibling ?? el.firstChild!;
  r.setStart(t.nodeType === 3 ? t : t.firstChild ?? t, Math.min(off, t.textContent!.length));
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
};

describe("heading folds", () => {
  const md = "# A\n\none\n\n## B\n\ntwo\n\n# C\n\nthree";
  it("fold hides until the next heading of the same or higher level; markdown unchanged", () => {
    const { el, ed } = mount(md);
    const [a, , b] = ed.getBlocks();
    ed.fold(a.id);
    expect(ed.isFolded(a.id)).toBe(true);
    expect(hidden(el)).toEqual(["one", "## B", "two"]);
    expect(ed.getMarkdown()).toBe(md);
    expect(el.children[0].classList.contains("tm-folded")).toBe(true);
    ed.unfold(a.id);
    expect(hidden(el)).toEqual([]);
    ed.toggleFold(b.id);
    expect(hidden(el)).toEqual(["two"]);
    expect(ed.getFolds()).toEqual([b.id]);
    ed.setFolds([a.id, "nope"]);
    expect(ed.getFolds()).toEqual([a.id]);
  });
  it("chevrons are UI (not source) and clicking toggles", () => {
    const { el, ed } = mount(md);
    const chev = el.querySelector<HTMLElement>(".tm-fold-chevron")!;
    expect(chev.closest("[data-tm-ui]")).toBe(chev);
    expect(sourceText(el.children[0] as HTMLElement)).toBe("# A");
    chev.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(ed.isFolded(ed.getBlocks()[0].id)).toBe(true);
    expect(el.querySelectorAll(".tm-fold-chevron").length).toBe(3);
  });
  it("folds survive edits and re-renders", () => {
    const { el, ed } = mount(md);
    const a = ed.getBlocks()[0];
    ed.fold(a.id);
    ed.updateBlock(a.id, "# A changed");
    ed.refresh();
    expect(ed.isFolded(a.id)).toBe(true);
    expect(hidden(el)).toEqual(["one", "## B", "two"]);
    ed.updateBlock(a.id, "plain now");
    expect(ed.isFolded(a.id)).toBe(false);
    expect(hidden(el)).toEqual([]);
  });
  it("caret inside a block that gets hidden moves to the heading end", () => {
    const { el, ed } = mount(md);
    const blocks = ed.getBlocks();
    caretIn(el.children[1] as HTMLElement, 1);
    expect(ed.caretBlockId()).toBe(blocks[1].id);
    ed.fold(blocks[0].id);
    expect(ed.caretBlockId()).toBe(blocks[0].id);
  });
  it("Cmd/Ctrl+Alt+[ / ] fold and unfold the caret's section", () => {
    const { el, ed } = mount(md);
    const blocks = ed.getBlocks();
    caretIn(el.children[1] as HTMLElement, 1);
    key(el, { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true });
    expect(ed.isFolded(blocks[0].id)).toBe(true);
    expect(ed.caretBlockId()).toBe(blocks[0].id);
    key(el, { key: "]", code: "BracketRight", ctrlKey: true, altKey: true });
    expect(ed.isFolded(blocks[0].id)).toBe(false);
  });
});

describe("foldable callouts", () => {
  it("callout + following > lines round-trip tightly", () => {
    for (const md of ["> [!note] T\n> body\n> more", "> [!note]- T\n> body\n\npara", "> a\n> b", "> [!tip] x\n\n> [!warning] y"]) {
      expect(serialize(parse(md))).toBe(md);
    }
  });
  it("`-` starts collapsed, `+` / none start expanded; chevron toggles view only", () => {
    const md = "> [!note]- Closed\n> hidden body\n\n> [!tip]+ Open\n> shown body";
    const { el, ed } = mount(md);
    const [c1, , c2] = ed.getBlocks();
    expect(ed.isFolded(c1.id)).toBe(true);
    expect(ed.isFolded(c2.id)).toBe(false);
    expect(hidden(el)).toEqual(["> hidden body"]);
    ed.toggleFold(c1.id);
    expect(hidden(el)).toEqual([]);
    expect(ed.getMarkdown()).toBe(md);
    ed.toggleFold(c2.id);
    expect(hidden(el)).toEqual(["> shown body"]);
  });
});

describe("+++ toggle blocks", () => {
  const md = "+++ Details\n\nbody one\n\n- item\n\n+++\n\nafter";
  it("round-trips, nests, and folds its body (including the closing fence)", () => {
    expect(serialize(parse(md))).toBe(md);
    const nested = "+++ Outer\n\n+++ Inner\n\nx\n\n+++\n\ny\n\n+++\n\nz";
    expect(serialize(parse(nested))).toBe(nested);
    const { el, ed } = mount(nested);
    ed.fold(ed.getBlocks()[0].id);
    expect(hidden(el)).toEqual(["+++ Inner", "x", "+++", "y", "+++"]);
    expect(ed.getMarkdown()).toBe(nested);
  });
  it("renders a summary row with a chevron; the title stays editable source", () => {
    const { el, ed } = mount(md);
    const head = el.children[0] as HTMLElement;
    expect(head.dataset.ext).toBe("toggle");
    expect(head.dataset.toggle).toBe("open");
    expect(head.querySelector(".tm-fold-chevron")).not.toBeNull();
    expect(sourceText(head)).toBe("+++ Details");
    expect((el.children[3] as HTMLElement).dataset.toggle).toBe("end");
    ed.toggleFold(ed.getBlocks()[0].id);
    expect(hidden(el)).toEqual(["body one", "- item", "+++"]);
  });
  it("Enter at the end of an unclosed `+++ Title` adds the closing fence and an empty body", () => {
    const { el, ed } = mount("+++ New");
    caretIn(el.children[0] as HTMLElement, 3);
    key(el, { key: "Enter" });
    expect(ed.getMarkdown().startsWith("+++ New\n\n\n\n+++")).toBe(true);
    expect(ed.getBlocks()[1].src).toBe("");
    expect(ed.caretBlockId()).toBe(ed.getBlocks()[1].id);
  });
});
