import { describe, expect, it } from "vitest";
import { htmlToMarkdown as md } from "../src/paste";

describe("htmlToMarkdown", () => {
  it("headings and paragraphs", () => {
    expect(md("<h1>Title</h1><p>Body text</p><h3>Sub</h3>")).toBe("# Title\n\nBody text\n\n### Sub");
  });

  it("bold, italic, strike, inline code", () => {
    expect(md("<p><strong>b</strong> <em>i</em> <del>s</del> <code>c</code></p>")).toBe("**b** *i* ~~s~~ `c`");
    expect(md('<p><span style="font-weight:700">w</span></p>')).toBe("**w**");
  });

  it("links and images", () => {
    expect(md('<p><a href="https://a.b/c">site</a> <img src="https://x/y.png" alt="pic"></p>')).toBe("[site](https://a.b/c) ![pic](https://x/y.png)");
    expect(md('<p><a href="https://a.b">https://a.b</a></p>')).toBe("<https://a.b>");
    expect(md('<p><a href="https://a.b/x_y">https://a.b/x_y</a></p>')).toBe("<https://a.b/x_y>");
  });

  it("nested ul/ol", () => {
    expect(md("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")).toBe("- a\n  - b\n- c");
    expect(md('<ol start="3"><li>x</li><li>y<ol><li>z</li></ol></li></ol>')).toBe("3. x\n4. y\n  1. z");
  });

  it("task lists", () => {
    expect(md('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>')).toBe("- [x] done\n- [ ] todo");
  });

  it("blockquote", () => {
    expect(md("<blockquote><p>one</p><p>two</p></blockquote>")).toBe("> one\n>\n> two");
  });

  it("pre/code with language", () => {
    expect(md('<pre><code class="language-ts">let a = 1;\n</code></pre>')).toBe("```ts\nlet a = 1;\n```");
    expect(md("<pre><code>*x* _y_</code></pre>")).toBe("```\n*x* _y_\n```");
  });

  it("table", () => {
    expect(md("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table>")).toBe("| A | B |\n| --- | --- |\n| 1 | 2\\|3 |");
  });

  it("Google Docs bold wrapper is not bold", () => {
    expect(md('<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span>plain</span> <span style="font-weight:700">bold</span></p></b>')).toBe("plain **bold**");
  });

  it("strips script and style", () => {
    expect(md("<style>p{}</style><p>ok</p><script>alert(1)</script>")).toBe("ok");
  });

  it("escapes literal markdown characters in text", () => {
    expect(md("<p>2 * 3 and snake_case</p>")).toBe("2 \\* 3 and snake\\_case");
    expect(md("<p># not heading</p>")).toBe("\\# not heading");
  });
});
