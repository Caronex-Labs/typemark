import { describe, expect, it } from "vitest";
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
];

describe("invariant: textContent(render(src)) === src", () => {
  for (const s of SAMPLES) it(`inline: ${s}`, () => expect(text(renderInline(s))).toBe(s));
  const blocks = ["# Title **x**", "> quote *a*", "- item", "  - nested", "3. third", "- [x] done", "---", "```js\nconst a = 1;\n```", "```\nopen fence"];
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
