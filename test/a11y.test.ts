import { describe, expect, it } from "vitest";
import { createEditor, registerExtension } from "../src/index";
import { aiEventText, blockLabel } from "../src/a11y";

const mount = (value = "", opts: Record<string, unknown> = {}) => {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, ed: createEditor(el, { value, ...opts }) };
};
const key = (target: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

describe("accessibility", () => {
  it("editor root is a labelled multiline textbox", () => {
    const { el } = mount("hi");
    expect(el.getAttribute("role")).toBe("textbox");
    expect(el.getAttribute("aria-multiline")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Markdown editor");
    expect(el.getAttribute("aria-readonly")).toBe("false");
    expect(mount("x", { ariaLabel: "Notes" }).el.getAttribute("aria-label")).toBe("Notes");
  });

  it("reflects read-only mode", () => {
    const { el, ed } = mount("hi", { readOnly: true });
    expect(el.getAttribute("aria-readonly")).toBe("true");
    ed.setReadOnly(false);
    expect(el.getAttribute("aria-readonly")).toBe("false");
  });

  it("owns a polite, visually hidden live region; announce() writes to it", () => {
    const { ed } = mount("hi");
    const live = ed.liveRegion;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.classList.contains("tm-sr-only")).toBe(true);
    ed.announce("Hello");
    expect(live.textContent!.trim()).toBe("Hello");
    ed.announce("Hello");
    expect(live.textContent!.trim()).toBe("Hello"); // repeat still changes the node text
  });

  it("announces block type changes, source mode, undo and redo", () => {
    const { ed } = mount("hello");
    ed.exec({ type: "heading", level: 2 });
    expect(ed.liveRegion.textContent!.trim()).toBe("Heading 2");
    ed.exec({ type: "bulletList" });
    expect(ed.liveRegion.textContent!.trim()).toBe("Bulleted list");
    ed.undo();
    expect(ed.liveRegion.textContent!.trim()).toBe("Undo");
    ed.redo();
    expect(ed.liveRegion.textContent!.trim()).toBe("Redo");
    ed.setSourceMode(true);
    expect(ed.liveRegion.textContent).toMatch(/Source mode on/);
  });

  it("task checkbox has checkbox semantics and toggles with Ctrl+Enter", () => {
    const { el, ed } = mount("- [ ] buy **milk**");
    const box = () => el.querySelector<HTMLElement>(".md-task-box")!;
    expect(box().getAttribute("role")).toBe("checkbox");
    expect(box().getAttribute("aria-checked")).toBe("false");
    expect(box().getAttribute("aria-label")).toBe("buy milk");
    el.focus();
    ed.selectDoc(8);
    key(el, "Enter", { ctrlKey: true });
    expect(ed.getMarkdown()).toBe("- [x] buy **milk**");
    expect(box().getAttribute("aria-checked")).toBe("true");
    expect(ed.liveRegion.textContent!.trim()).toBe("Checked");
  });

  it("images keep alt text from markdown", () => {
    const { el } = mount("![a cat](cat.png)");
    expect(el.querySelector("img")!.getAttribute("alt")).toBe("a cat");
  });

  it("suggestion menu is a listbox driven by aria-activedescendant", async () => {
    registerExtension({
      name: "a11y-test",
      suggesters: [{ name: "pct", trigger: "%", items: () => [{ label: "One", apply: "1" }, { label: "Two", apply: "2" }] }],
    });
    const R = Range.prototype as unknown as Record<string, unknown>;
    R.getClientRects ??= () => [];
    R.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
    const { el, ed } = mount("");
    el.focus();
    ed.selectDoc(0);
    ed.replaceDoc(0, 0, "%", "type");
    ed.selectDoc(1);
    // replaceDoc may not open the menu; drive it through a typed change
    (ed as unknown as { updateSuggest(): Promise<void> }).updateSuggest?.();
    await new Promise((r) => setTimeout(r, 0));
    const menu = document.querySelector<HTMLElement>(".tm-suggest");
    expect(menu?.getAttribute("role")).toBe("listbox");
    if (menu && !menu.hidden) {
      expect(el.getAttribute("aria-expanded")).toBe("true");
      expect(el.getAttribute("aria-controls")).toBe(menu.id);
      const first = el.getAttribute("aria-activedescendant")!;
      expect(document.getElementById(first)?.getAttribute("role")).toBe("option");
      expect(document.getElementById(first)?.getAttribute("aria-selected")).toBe("true");
      key(el, "ArrowDown");
      expect(el.getAttribute("aria-activedescendant")).toBe(`${menu.id}-1`);
      key(el, "Escape");
      expect(menu.hidden).toBe(true);
      expect(el.getAttribute("aria-expanded")).toBe("false");
      expect(el.hasAttribute("aria-activedescendant")).toBe(false);
    } else {
      throw new Error("suggest menu did not open");
    }
  });

  it("AI events are announced with kind and author", () => {
    const { ed } = mount("Hello world.\n\nSecond.");
    ed.ai.addNote({ from: 0, to: 5, kind: "question", body: "Which world?", author: "Docs agent" });
    expect(ed.liveRegion.textContent).toMatch(/^Question added by Docs agent: Which world\?/);
    ed.ai.suggestEdit(6, 11, "there", { author: "Style agent" });
    expect(ed.liveRegion.textContent).toMatch(/Suggestion added by Style agent/);
    const thread = ed.root.querySelector(".tm-phantom-thread");
    if (thread) {
      expect(thread.getAttribute("role")).toBe("group");
      expect(thread.getAttribute("aria-label")).toMatch(/Review thread from .*Docs agent/);
    }
  });

  it("formats labels", () => {
    expect(blockLabel("heading", "### x")).toBe("Heading 3");
    expect(blockLabel("ol")).toBe("Numbered list");
    expect(aiEventText({ type: "rejected", text: "x" })).toBe("Suggestion rejected");
    expect(aiEventText({ type: "mark", text: "x" })).toBeNull();
  });
});
