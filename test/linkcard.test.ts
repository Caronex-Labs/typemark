import { describe, expect, it, vi } from "vitest";
import { createEditor, parse, serialize } from "../src/index";
import { sourceText } from "../src/caret";

const mount = (value: string, linkPreview?: (u: string) => Promise<any>) => {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, ed: createEditor(el, { value, linkPreview }) };
};

describe("link cards", () => {
  it("a bare URL paragraph is a widget; a URL inside a paragraph is not; markdown unchanged", () => {
    const { ed } = mount("https://example.com/a?b=1\n\nsee:\nhttps://example.com\n\ntext https://x.org");
    expect(ed.getBlocks().map((b) => b.type)).toEqual(["widget", "paragraph", "paragraph"]);
    expect(ed.getMarkdown()).toBe("https://example.com/a?b=1\n\nsee:\nhttps://example.com\n\ntext https://x.org");
    const md = "intro\nhttps://a.com\n\nhttps://b.com";
    expect(serialize(parse(md))).toBe(md);
  });
  it("without a hook: compact card with host + URL", () => {
    const { el } = mount("https://example.com/page");
    const card = el.querySelector<HTMLElement>(".md-linkcard")!;
    expect(card.classList.contains("md-linkcard-compact")).toBe(true);
    expect(card.querySelector(".md-linkcard-host")!.textContent).toBe("example.com");
    expect(card.querySelector(".md-linkcard-url")!.textContent).toBe("https://example.com/page");
    expect(sourceText(el.children[0] as HTMLElement)).toBe("https://example.com/page");
  });
  it("with a hook: loading card, then title/description/image; results cached per URL", async () => {
    const hook = vi.fn(async (u: string) => ({ title: "Example", description: "An example page", image: "https://example.com/i.png", siteName: "Ex", favicon: "https://example.com/f.ico", u }));
    const { el, ed } = mount("https://example.com/x", hook);
    expect(el.querySelector(".md-linkcard-loading")).not.toBeNull();
    await vi.waitFor(() => expect(el.querySelector(".md-linkcard-title")?.textContent).toBe("Example"));
    expect(el.querySelector(".md-linkcard-desc")!.textContent).toBe("An example page");
    expect(el.querySelector<HTMLImageElement>(".md-linkcard-image")!.src).toBe("https://example.com/i.png");
    expect(el.querySelector(".md-linkcard-host")!.textContent).toBe("Ex");
    ed.refresh();
    await vi.waitFor(() => expect(el.querySelector(".md-linkcard-title")?.textContent).toBe("Example"));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(ed.getMarkdown()).toBe("https://example.com/x");
  });
  it("hook returning null or throwing falls back to the compact card", async () => {
    const { el } = mount("https://fail.example/", async () => {
      throw new Error("nope");
    });
    await vi.waitFor(() => expect(el.querySelector(".md-linkcard-loading")).toBeNull());
    expect(el.querySelector(".md-linkcard-compact .md-linkcard-host")!.textContent).toBe("fail.example");
  });
  it("clicking the card puts the caret into the URL source", () => {
    const { el, ed } = mount("https://example.com");
    el.querySelector<HTMLElement>(".md-widget")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(ed.caretBlockId()).toBe(ed.getBlocks()[0].id);
  });
});
