import { describe, expect, it } from "vitest";
import { createEditor, registerExtension, unregisterExtension } from "../src/index";
import { sourceText } from "../src/caret";

const mount = (v: string) => {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, ed: createEditor(el, { value: v }) };
};

describe("README extension examples work as printed", () => {
  it("issue keys", () => {
    registerExtension({
      name: "issues",
      inline: [{ name: "issue", trigger: "", pattern: /\b([A-Z]{2,6}-\d+)\b/, data: (m) => ({ key: m[1] }), modClick: true, decorate: (el, d) => (el.title = `Open ${d.key}`) }],
    });
    const { el, ed } = mount("Fixes ENG-42 and not eng-1.");
    const x = el.querySelector<HTMLElement>(".md-x-issue")!;
    expect([x.dataset.key, x.title]).toEqual(["ENG-42", "Open ENG-42"]);
    expect(el.querySelectorAll(".md-x-issue").length).toBe(1);
    expect(sourceText(el.children[0] as HTMLElement)).toBe(ed.getMarkdown());
    unregisterExtension("issues");
  });
  it("admonition prefix block", () => {
    registerExtension({ name: "admonition", blocks: [{ kind: "prefix", name: "admonition", prefix: /^!!! (\w+) /, data: (src) => ({ level: src.match(/^!!! (\w+)/)![1] }) }] });
    const { el } = mount("!!! warning Mind the gap");
    expect((el.children[0] as HTMLElement).dataset.level).toBe("warning");
    unregisterExtension("admonition");
  });
  it("chart widget", () => {
    registerExtension({
      name: "chart",
      blocks: [{ kind: "widget", name: "chart", fence: "chart", render({ el, body }) { el.innerHTML = body.split("\n").map((l) => l.split(":")).filter((r) => r.length === 2).map(([k, v]) => `<div>${k} ${v}</div>`).join(""); } }],
    });
    const { el, ed } = mount("```chart\na: 3\nb: 5\n```");
    expect(el.querySelectorAll("[data-tm-ui] div").length).toBe(2);
    expect(ed.getMarkdown()).toBe("```chart\na: 3\nb: 5\n```");
    unregisterExtension("chart");
  });
  it("emoji suggester", async () => {
    const EMOJI: Record<string, string> = { tada: "🎉", rocket: "🚀" };
    const items = (q: string) => Object.entries(EMOJI).filter(([k]) => k.startsWith(q)).map(([k, e]) => ({ label: `${e} ${k}`, apply: e }));
    registerExtension({ name: "emoji", suggesters: [{ name: "emoji", trigger: ":", items }] });
    expect(items("ro")).toEqual([{ label: "🚀 rocket", apply: "🚀" }]);
    unregisterExtension("emoji");
  });
});
