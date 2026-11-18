import { describe, expect, it, vi } from "vitest";
import { actionButtons, createEditor, registerExtension, tags, unregisterExtension, wikilinks } from "../src/index";
import { sourceText } from "../src/caret";

const mount = (value: string) => {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, ed: createEditor(el, { value }) };
};
const blockEl = (el: HTMLElement, i = 0) => el.children[i] as HTMLElement;

describe("core syntax", () => {
  it("@[title](url) embed widget", () => {
    const { el, ed } = mount("@[Demo](https://youtu.be/abc)");
    expect(ed.getBlocks()[0].type).toBe("widget");
    expect(el.querySelector("iframe")!.getAttribute("src")).toBe("https://www.youtube.com/embed/abc");
    expect(el.querySelector(".md-embed-caption")!.textContent).toBe("Demo");
    expect(sourceText(blockEl(el))).toBe("@[Demo](https://youtu.be/abc)");
  });
  it("[toc] lists headings and stays live", () => {
    const { el, ed } = mount("[toc]\n\n# A\n\n## B");
    expect([...el.querySelectorAll(".md-toc-item")].map((a) => a.textContent)).toEqual(["A", "B"]);
    ed.exec({ type: "insertBlock", src: "## C" });
    expect(el.querySelectorAll(".md-toc-item").length).toBe(3);
  });
  it("> [!warning] callouts keep editable inline text", () => {
    const { el, ed } = mount("> [!warning] **careful** now");
    const b = blockEl(el);
    expect(b.dataset.callout).toBe("warning");
    expect(b.querySelector("strong")).not.toBeNull();
    expect(sourceText(b)).toBe(ed.getMarkdown());
  });
  it("front matter renders a properties panel without breaking the source", () => {
    const md = "---\ntitle: Hello\ntags: [a, b]\n---\n\nbody";
    const { el, ed } = mount(md);
    expect(ed.getFrontmatter()!.data).toEqual({ title: "Hello", tags: ["a", "b"] });
    expect(el.querySelectorAll(".md-prop-pill").length).toBe(2);
    expect(sourceText(blockEl(el))).toBe("---\ntitle: Hello\ntags: [a, b]\n---");
    expect(ed.getMarkdown()).toBe(md);
    ed.setFrontmatter("title: Bye");
    expect(ed.getMarkdown()).toBe("---\ntitle: Bye\n---\n\nbody");
  });
});

describe("extension API", () => {
  it("wikilinks + tags: syntax, data, click callbacks", () => {
    const onOpen = vi.fn();
    const onTag = vi.fn();
    registerExtension(wikilinks({ onOpen, exists: (t) => t === "Home", plainClick: true }));
    registerExtension(tags({ onOpen: onTag, plainClick: true }));
    const { el, ed } = mount("see [[Home|start]] and [[Nope]] #idea but not a#b");
    const links = el.querySelectorAll<HTMLElement>(".md-x-wikilink");
    expect([...links].map((l) => l.dataset.target)).toEqual(["Home", "Nope"]);
    expect(links[1].classList.contains("md-x-missing")).toBe(true);
    expect(el.querySelectorAll(".md-x-tag").length).toBe(1);
    expect(sourceText(blockEl(el))).toBe(ed.getMarkdown());
    links[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith("Home", expect.anything());
    el.querySelector(".md-x-tag")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onTag).toHaveBeenCalledWith("idea", expect.anything());
    unregisterExtension("wikilinks");
    unregisterExtension("tags");
  });

  it("widget blocks: host renders, setSource persists state, cleanup runs", () => {
    const cleanup = vi.fn();
    registerExtension({
      name: "counter",
      blocks: [
        {
          kind: "widget",
          name: "counter",
          pattern: /\{\{count:(\d+)\}\}/,
          render({ el, match, setSource }) {
            const b = document.createElement("button");
            b.textContent = `clicked ${match![1]}`;
            b.onclick = () => setSource(`{{count:${Number(match![1]) + 1}}}`);
            el.append(b);
            return cleanup;
          },
        },
      ],
    });
    const { el, ed } = mount("{{count:0}}");
    el.querySelector("button")!.click();
    expect(ed.getMarkdown()).toBe("{{count:1}}");
    expect(el.querySelector("button")!.textContent).toBe("clicked 1");
    expect(cleanup).toHaveBeenCalledTimes(1);
    ed.undo();
    expect(ed.getMarkdown()).toBe("{{count:0}}");
    unregisterExtension("counter");
  });

  it("action buttons call the host with parsed args", async () => {
    const onAction = vi.fn();
    registerExtension(actionButtons({ onAction }));
    const { el } = mount("```button\nlabel: Ship it\naction: deploy\nenv: prod\n```");
    const btn = el.querySelector<HTMLButtonElement>(".md-action-button")!;
    expect(btn.textContent).toBe("Ship it");
    btn.click();
    await Promise.resolve();
    expect(onAction.mock.calls[0][0]).toEqual({ label: "Ship it", action: "deploy", args: { env: "prod" } });
    unregisterExtension("buttons");
  });

  it("inline parts that drop text are rejected (invariant guard)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerExtension({ name: "bad", inline: [{ name: "bad", trigger: "%%", pattern: /%%(\w+)%%/, parts: (m) => [{ text: m[1] }] }] });
    const { el, ed } = mount("a %%x%% b");
    expect(el.querySelector(".md-x-bad")).toBeNull();
    expect(sourceText(blockEl(el))).toBe(ed.getMarkdown());
    unregisterExtension("bad");
    warn.mockRestore();
  });
});
