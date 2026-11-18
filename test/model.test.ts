import { describe, expect, it } from "vitest";
import "../src/math";
import { renderInline } from "../src/inline";
import { blockType, continuation, parse, renderBlock, serialize } from "../src/block";

const text = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent;
};

const SAMPLES = [
  "plain text",
  "a **bold** and *em* and `code` here",
  "nested **bold *em* inside**",
  "[link **x**](http://a.b) and ![img](p.png)",
  "~~gone~~ ==mark== \\*escaped\\*",
  "snake_case_name stays plain",
  "unclosed **bold and `tick",
  "<script>alert(1)</script> & \"q\"",
  "euler $e^{i\\pi}+1=0$ and $5 not math",
  "see note[^1] and [^long-id]",
];

describe("invariant: textContent(render(src)) === src", () => {
  for (const s of SAMPLES) it(`inline: ${s}`, () => expect(text(renderInline(s))).toBe(s));
  const blocks = ["# Title **x**", "> quote *a*", "- item", "  - nested", "3. third", "- [x] done", "---", "```js\nconst a = 1;\n```", "```\nopen fence", "> > nested *q*", "[^1]: the note", "$$\n\\int_0^1 x\\,dx\n$$", "$$\nopen", "```js\nconst s = \"<a>\"; // c\n```", "| a | **b** |\n|:--|--:|\n| 1 | 2 |\n|   |   |", "| x | y |\n|---|---|\n| broken", "| a | `x | y` |\n|---|---|\n| 1 | 2 |"];
  for (const s of blocks) it(`block: ${JSON.stringify(s)}`, () => expect(text(renderBlock(s).html)).toBe(s));
});

describe("inline structure", () => {
  it("records raw offsets", () => {
    const d = document.createElement("div");
    d.innerHTML = renderInline("ab **cd**", 2);
    const s = d.querySelector("strong") as HTMLElement;
    expect([s.dataset.s, s.dataset.e]).toEqual(["5", "11"]);
  });
  it("escapes html", () => expect(renderInline("<b>")).toBe("&lt;b&gt;"));
  it("blocks javascript: urls", () => expect(renderInline("[x](javascript:alert(1))")).not.toMatch(/href="javascript/));
});

describe("blocks", () => {
  it("types", () => {
    expect(blockType("## h")).toBe("heading");
    expect(blockType("- [ ] t")).toBe("task");
    expect(blockType("***")).toBe("hr");
    expect(blockType("#nospace")).toBe("paragraph");
  });
  it("continuation", () => {
    expect(continuation("- a")).toBe("- ");
    expect(continuation("9. a")).toBe("10. ");
    expect(continuation("- [x] a")).toBe("- [ ] ");
    expect(continuation("# a")).toBeNull();
  });
  it("round-trips a document", () => {
    const md = "# T\n\npara line1\nline2\n\n- a\n- b\n\n> q\n\n```py\nx = 1\n\ny = 2\n```\n\n---\n\nend";
    expect(serialize(parse(md))).toBe(md);
  });
});

describe("new block types", () => {
  it("types", () => {
    expect(blockType("> > q")).toBe("quote");
    expect(blockType("[^a]: b")).toBe("footnote");
    expect(blockType("$$\nx\n$$")).toBe("math");
    expect(blockType("| a |\n|---|")).toBe("table");
    expect(continuation("> > q")).toBe("> > ");
  });
  it("round-trips tables, math, footnotes", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n$$\n\ntext[^1]\n\n> > deep\n\n[^1]: note";
    const bl = parse(md);
    expect(bl.map((b) => blockType(b.src))).toEqual(["table", "math", "paragraph", "quote", "footnote"]);
    expect(serialize(bl)).toBe(md);
  });
  it("highlights code without changing its text", () => {
    const html = renderBlock("```js\nconst a = 1;\n```").html;
    expect(html).toContain("hljs-keyword");
  });
  it("inline math renders a shadow formula with no text", () => {
    const d = document.createElement("div");
    document.body.append(d);
    d.innerHTML = renderInline("$x^2$");
    const m = d.querySelector("tm-math")!;
    expect(m.textContent).toBe("");
    expect(m.shadowRoot?.innerHTML).toContain("katex");
  });
});

it("code spans protect table pipes", () => {
  const d = document.createElement("div");
  d.innerHTML = renderBlock("| a | `x | y` |\n|---|---|").html;
  expect(d.querySelectorAll("th").length).toBe(2);
});

it("mixed list kinds stay tight", () => {
  const md = "- a\n- [ ] b\n1. c";
  expect(serialize(parse(md))).toBe(md);
});
