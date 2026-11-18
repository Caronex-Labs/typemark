import { describe, expect, it, vi } from "vitest";
import { createEditor } from "../src/index";

const mount = (value = "") => {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, ed: createEditor(el, { value }) };
};

describe("Editor API", () => {
  it("round-trips markdown", () => {
    const md = "# T\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |";
    expect(mount(md).ed.getMarkdown()).toBe(md);
  });

  it("exec heading / list toggles the block prefix", () => {
    const { ed } = mount("hello");
    ed.exec({ type: "heading", level: 2 });
    expect(ed.getMarkdown()).toBe("## hello");
    ed.exec({ type: "heading", level: 2 });
    expect(ed.getMarkdown()).toBe("hello");
    ed.exec({ type: "bulletList" });
    expect(ed.getMarkdown()).toBe("- hello");
    ed.exec({ type: "orderedList" });
    expect(ed.getMarkdown()).toBe("1. hello");
  });

  it("exec inserts block structures", () => {
    const { ed } = mount("");
    ed.exec({ type: "table" });
    expect(ed.getMarkdown()).toBe("|   |   |\n| --- | --- |\n|   |   |");
  });

  it("undo / redo through exec", () => {
    const { ed } = mount("x");
    ed.exec({ type: "quote" });
    expect(ed.getMarkdown()).toBe("> x");
    ed.exec({ type: "undo" });
    expect(ed.getMarkdown()).toBe("x");
    ed.exec({ type: "redo" });
    expect(ed.getMarkdown()).toBe("> x");
  });

  it("onChange fires with the document", () => {
    const el = document.createElement("div");
    const onChange = vi.fn();
    const ed = createEditor(el, { value: "a", onChange });
    ed.exec({ type: "heading", level: 1 });
    expect(onChange).toHaveBeenLastCalledWith("# a");
  });

  it("readOnly blocks commands and editing", () => {
    const el = document.createElement("div");
    const ed = createEditor(el, { value: "a", readOnly: true });
    expect(el.contentEditable).toBe("false");
    ed.exec({ type: "heading", level: 1 });
    expect(ed.getMarkdown()).toBe("a");
    ed.setReadOnly(false);
    expect(el.contentEditable).toBe("true");
  });

  it("destroy leaves rendered content and stops editing", () => {
    const { el, ed } = mount("**b**");
    ed.destroy();
    expect(el.contentEditable).toBe("false");
    expect(el.querySelector("strong")).not.toBeNull();
  });

  it("multiple editors are independent", () => {
    const a = mount("one").ed;
    const b = mount("two").ed;
    a.exec({ type: "heading", level: 1 });
    expect([a.getMarkdown(), b.getMarkdown()]).toEqual(["# one", "two"]);
  });
});
