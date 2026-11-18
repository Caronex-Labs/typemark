import { describe, expect, it } from "vitest";
import { createEditor } from "../src/index";

const mount = (v: string) => {
  const el = document.createElement("div");
  document.body.append(el);
  return createEditor(el, { value: v });
};

describe("find & replace", () => {
  it("finds over the markdown source with options", () => {
    const ed = mount("Cat cat **cat** catalog");
    expect(ed.find.setQuery("cat").length).toBe(4);
    expect(ed.find.setQuery("cat", { caseSensitive: true }).length).toBe(3);
    expect(ed.find.setQuery("cat", { wholeWord: true }).length).toBe(3);
    expect(ed.find.setQuery("c.t", { regex: true }).length).toBe(4);
  });
  it("replace one, replace all as one undo step, regex groups", () => {
    const ed = mount("one two one two");
    ed.find.setQuery("one");
    ed.find.replace("1");
    expect(ed.getMarkdown()).toBe("1 two one two");
    expect(ed.find.replaceAll("2")).toBe(1);
    ed.find.setQuery("two");
    ed.find.replaceAll("three");
    expect(ed.getMarkdown()).toBe("1 three 2 three");
    ed.undo();
    expect(ed.getMarkdown()).toBe("1 two 2 two");
    ed.find.setQuery("(\\d) (\\w+)", { regex: true });
    ed.find.replaceAll("$2-$1");
    expect(ed.getMarkdown()).toBe("two-1 two-2");
  });
  it("matches follow edits; invalid regex is reported, not thrown", () => {
    const ed = mount("alpha beta");
    ed.find.setQuery("beta");
    ed.replaceDoc(0, 0, "beta ");
    expect(ed.find.matches().map((m) => m.from)).toEqual([0, 11]);
    expect(ed.find.setQuery("(", { regex: true })).toEqual([]);
  });
});
