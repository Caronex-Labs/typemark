import { describe, expect, it } from "vitest";
import { createEditor, registerFenceRenderer } from "../src/index";
import { blockType, parse, renderBlock, serialize } from "../src/block";
import { renderInline } from "../src/inline";
import { buildEmbed, defaultEmbedPolicy, embedHtmlFor } from "../src/media";

const text = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent;
};

describe("images", () => {
  it("bracketed urls and titles keep the invariant", () => {
    for (const s of ['![a](<my pic.png> "T")', "![x](data:image/png;base64,AAAA)", '[l](<a b> "t")'])
      expect(text(renderInline(s))).toBe(s);
  });
  it("renders src from <...> and allows data:image", () => {
    expect(renderInline("![a](<my pic.png>)")).toContain('src="my pic.png"');
    expect(renderInline("![a](data:image/png;base64,AA)")).toContain('src="data:image/png;base64,AA"');
    expect(renderInline("![a](javascript:x)")).toContain('src="#"');
  });
  it("exec image inserts markdown, resolveImageUrl maps src", () => {
    const el = document.createElement("div");
    const ed = createEditor(el, { value: "", resolveImageUrl: (s) => "https://cdn.test/" + s });
    ed.exec({ type: "image", src: "a b.png", alt: "pic" });
    expect(ed.getMarkdown()).toBe("![pic](<a b.png>)");
    expect(el.querySelector("img")!.getAttribute("src")).toBe("https://cdn.test/a b.png");
  });
  it("insertImages uploads through the hook", async () => {
    const el = document.createElement("div");
    const ed = createEditor(el, { value: "x", uploadImage: async (f) => `/up/${f.name}` });
    await ed.insertImages([new File(["1"], "cat.png", { type: "image/png" }), new File(["1"], "notes.txt", { type: "text/plain" })]);
    expect(ed.getMarkdown()).toBe("x![cat](/up/cat.png)");
  });
});

describe("embeds", () => {
  it("parses an iframe block and keeps the invariant", () => {
    const src = '<iframe src="https://www.youtube.com/embed/abc" width="100%"></iframe>';
    expect(blockType(src)).toBe("html");
    expect(text(renderBlock(src).html)).toBe(src);
    const md = `before\n\n${src}\n\nafter`;
    expect(serialize(parse(md))).toBe(md);
  });
  it("provider URLs become embeds", () => {
    expect(embedHtmlFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toContain("youtube.com/embed/dQw4w9WgXcQ");
    expect(embedHtmlFor("https://youtu.be/xyz")).toContain("youtube.com/embed/xyz");
    expect(embedHtmlFor("https://vimeo.com/123")).toContain("player.vimeo.com/video/123");
    expect(embedHtmlFor("https://x.test/a.mp4")).toMatch(/^<video/);
  });
  it("sanitises: only whitelisted attrs, sandboxed, policy enforced", () => {
    const ok = buildEmbed('<iframe src="https://e.test/x" onload="alert(1)" srcdoc="<b>">', defaultEmbedPolicy);
    expect(ok.tagName).toBe("IFRAME");
    expect(ok.getAttribute("onload")).toBeNull();
    expect(ok.getAttribute("srcdoc")).toBeNull();
    expect(ok.getAttribute("sandbox")).toContain("allow-scripts");
    expect(buildEmbed('<iframe src="http://e.test/x">', defaultEmbedPolicy).className).toBe("md-embed-note");
    expect(buildEmbed('<iframe src="javascript:alert(1)">', defaultEmbedPolicy).className).toBe("md-embed-note");
    expect(buildEmbed("<script>alert(1)</script>", defaultEmbedPolicy).className).toBe("md-embed-note");
  });
  it("editor mounts the embed and exec embed inserts one", () => {
    const el = document.createElement("div");
    const ed = createEditor(el, { value: "" });
    ed.exec({ type: "embed", url: "https://vimeo.com/42" });
    expect(ed.getMarkdown()).toContain("player.vimeo.com/video/42");
    expect(el.querySelector(".md-embed iframe")).not.toBeNull();
  });
});

describe("fence renderers", () => {
  it("code blocks with a registered renderer get a text-free preview", async () => {
    registerFenceRenderer("dot", (code, root) => {
      root.innerHTML = `<svg data-code="${code.length}"></svg>`;
    });
    const src = "```dot\na -> b\n```";
    const r = renderBlock(src);
    expect(r.attrs).toContain('data-preview="dot"');
    const d = document.createElement("div");
    document.body.append(d);
    d.innerHTML = r.html;
    expect(d.textContent).toBe(src);
    const pv = d.querySelector("tm-preview")!;
    await new Promise((res) => setTimeout(res, 0));
    expect(pv.shadowRoot!.innerHTML).toContain("<svg");
  });
  it("exec diagram inserts a mermaid fence", () => {
    const ed = createEditor(document.createElement("div"), { value: "" });
    ed.exec({ type: "diagram" });
    expect(ed.getMarkdown()).toMatch(/^```mermaid\ngraph TD/);
  });
});
