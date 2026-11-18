import { describe, expect, it } from "vitest";
import { createEditor } from "../src/index";
import type { EditorOptions } from "../src/editor";

const mount = (value = "", opts: EditorOptions = {}) => {
  const el = document.createElement("div");
  document.body.append(el);
  return createEditor(el, { value, ...opts });
};
type Ed = ReturnType<typeof mount>;

const fire = (ed: Ed, inputType: string, data: string | null = null) => {
  const e = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true });
  ed.root.dispatchEvent(e);
  return e.defaultPrevented;
};

/** Type characters; when the editor leaves one to the browser, insert it as the browser would. */
const type = (ed: Ed, text: string) => {
  for (const ch of text) {
    if (fire(ed, "insertText", ch)) continue;
    const s = ed.getSelectionOffsets()!;
    ed.replaceDoc(s.from, s.to, ch, "type");
    ed.selectDoc(s.from + 1);
  }
};
const caret = (ed: Ed) => ed.getSelectionOffsets();

describe("typing aids", () => {
  it("wraps a selection and keeps it selected; a second * makes bold", () => {
    const ed = mount("say hello now");
    ed.selectDoc(4, 9);
    type(ed, "*");
    expect(ed.getMarkdown()).toBe("say *hello* now");
    expect(caret(ed)).toEqual({ from: 5, to: 10 });
    type(ed, "*");
    expect(ed.getMarkdown()).toBe("say **hello** now");
  });

  it("wraps with brackets and parens", () => {
    const ed = mount("a link b");
    ed.selectDoc(2, 6);
    type(ed, "[");
    expect(ed.getMarkdown()).toBe("a [link] b");
    ed.selectDoc(3, 7);
    type(ed, "(");
    expect(ed.getMarkdown()).toBe("a [(link)] b");
  });

  it("auto-closes, types over the closer, and backspace deletes an empty pair", () => {
    const ed = mount("x");
    ed.selectDoc(1);
    type(ed, "(");
    expect(ed.getMarkdown()).toBe("x()");
    expect(caret(ed)).toEqual({ from: 2, to: 2 });
    type(ed, "ab)");
    expect(ed.getMarkdown()).toBe("x(ab)");
    expect(caret(ed)).toEqual({ from: 5, to: 5 });
    type(ed, " [");
    expect(ed.getMarkdown()).toBe("x(ab) []");
    fire(ed, "deleteContentBackward");
    expect(ed.getMarkdown()).toBe("x(ab) ");
  });

  it("does not pair before a word character", () => {
    const ed = mount("word");
    ed.selectDoc(0);
    type(ed, "(");
    expect(ed.getMarkdown()).toBe("(word");
  });

  it("typing a fence yields exactly three backticks", () => {
    const ed = mount("");
    ed.selectDoc(0);
    type(ed, "```");
    expect(ed.getMarkdown()).toBe("```");
  });

  it("image and task syntax type through cleanly", () => {
    const ed = mount("");
    ed.selectDoc(0);
    type(ed, "![alt](u.png)");
    expect(ed.getMarkdown()).toBe("![alt](u.png)");
    const t = mount("- ");
    t.selectDoc(2);
    type(t, "[ ] todo");
    expect(t.getMarkdown()).toBe("- [ ] todo");
    const w = mount("");
    w.selectDoc(0);
    type(w, "[[");
    expect(w.getMarkdown()).toBe("[[]]");
    expect(caret(w)).toEqual({ from: 2, to: 2 });
  });

  it("smart punctuation", () => {
    const ed = mount("");
    ed.selectDoc(0);
    type(ed, "a -- b...");
    expect(ed.getMarkdown()).toBe("a — b…");
    const hr = mount("");
    hr.selectDoc(0);
    type(hr, "...");
    expect(hr.getMarkdown()).toBe("...");
  });

  it("is off inside code blocks and inline code", () => {
    const ed = mount("```\nx\n```");
    ed.selectDoc(5);
    type(ed, "(");
    expect(ed.getMarkdown()).toBe("```\nx(\n```");
    const ic = mount("a `b` c");
    ic.selectDoc(4);
    type(ic, "(");
    expect(ic.getMarkdown()).toBe("a `b(` c");
  });

  it("can be disabled", () => {
    const ed = mount("x", { typingAids: false });
    ed.selectDoc(1);
    type(ed, "(");
    expect(ed.getMarkdown()).toBe("x(");
  });
});

describe("clean paste", () => {
  const paste = (ed: Ed, data: Record<string, string>) => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { files: [], getData: (t: string) => data[t] ?? "" } });
    ed.root.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("converts html to markdown blocks", () => {
    const ed = mount("");
    ed.selectDoc(0);
    expect(paste(ed, { "text/html": "<h2>T</h2><p>a <b>b</b></p>", "text/plain": "T a b" })).toBe(true);
    expect(ed.getMarkdown()).toBe("## T\n\na **b**");
  });

  it("URL over a selection makes a link; plain text is left to the default path", () => {
    const ed = mount("see docs");
    ed.selectDoc(4, 8);
    paste(ed, { "text/plain": "https://x.dev/a" });
    expect(ed.getMarkdown()).toBe("see [docs](https://x.dev/a)");
    const p = mount("q");
    p.selectDoc(1);
    expect(paste(p, { "text/plain": "hi" })).toBe(false);
  });

  it("Cmd+Shift+V and code blocks skip conversion", () => {
    const ed = mount("");
    ed.selectDoc(0);
    ed.root.dispatchEvent(new KeyboardEvent("keydown", { key: "V", metaKey: true, shiftKey: true, bubbles: true }));
    expect(paste(ed, { "text/html": "<b>x</b>", "text/plain": "x" })).toBe(false);
    const c = mount("```\nx\n```");
    c.selectDoc(5);
    expect(paste(c, { "text/html": "<b>x</b>", "text/plain": "x" })).toBe(false);
  });
});
