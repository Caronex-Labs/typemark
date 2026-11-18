import { describe, expect, it } from "vitest";
import { buildBacklinks, extractMetadata } from "../src/index";

const DOC = `---
title: Release plan
tags: [planning, q3]
owner: sam
---

# Release

Ship with @alex and @sam. See [[Roadmap]] and [[Risks|the risks]] #planning #urgent.

- [x] Freeze API
- [ ] Write docs
  - [ ] Review docs with @jordan

## Notes

\`#notatag\` and \`@notamention\` in code. A [link](https://example.com), a [relative](./setup.md) and ![shot](img/a.png).

@[Demo](https://youtu.be/abc)

\`\`\`mermaid
graph LR
\`\`\`

$$
x
$$

> [!warning] Careful

@ai(research) Find competitor pricing

Text with a note[^1] and a missing one[^2].

[^1]: The note.
[^3]: Unused.`;

describe("extractMetadata", () => {
  const m = extractMetadata(DOC);
  it("properties and outline", () => {
    expect(m.title).toBe("Release plan");
    expect(m.frontmatter!.data.owner).toBe("sam");
    expect(m.headings.map((h) => [h.level, h.text])).toEqual([[1, "Release"], [2, "Notes"]]);
    expect(m.headings[0].line).toBe(7);
  });
  it("tasks with status, depth and section", () => {
    expect(m.tasks.map((t) => [t.text, t.done, t.depth, t.section])).toEqual([
      ["Freeze API", true, 0, "Release"],
      ["Write docs", false, 0, "Release"],
      ["Review docs with @jordan", false, 1, "Release"],
    ]);
    expect(m.taskSummary).toEqual({ total: 3, done: 1, open: 2 });
  });
  it("tags, mentions, links (code spans ignored)", () => {
    expect(m.tags).toEqual([{ tag: "planning", count: 2 }, { tag: "q3", count: 1 }, { tag: "urgent", count: 1 }]);
    expect(m.mentions.map((x) => x.name).sort()).toEqual(["alex", "jordan", "sam"]);
    expect(m.wikilinks.map((w) => [w.target, w.alias])).toEqual([["Roadmap", null], ["Risks", "the risks"]]);
    expect(m.links.map((l) => [l.url, l.external])).toEqual([["https://example.com", true], ["./setup.md", false]]);
    expect(m.images[0].src).toBe("img/a.png");
    expect(m.embeds[0]).toMatchObject({ url: "https://youtu.be/abc", title: "Demo" });
  });
  it("blocks, footnotes, instructions", () => {
    expect([m.diagrams, m.math, m.codeBlocks[0].lang]).toEqual([1, 1, "mermaid"]);
    expect(m.callouts[0].type).toBe("warning");
    expect(m.instructions[0]).toMatchObject({ agent: "research", instruction: "Find competitor pricing" });
    expect(m.footnotes).toEqual({ references: ["1", "2"], definitions: ["1", "3"], missing: ["2"], unused: ["3"] });
    expect(m.stats.words).toBeGreaterThan(20);
  });
  it("offsets point at the source", () => {
    const t = m.tasks[1];
    expect(DOC.slice(t.offset, t.offset + 13)).toBe("- [ ] Write d");
  });
});

describe("buildBacklinks", () => {
  it("resolves by id, title and relative path", () => {
    const { backlinks, unresolved } = buildBacklinks({
      "release.md": "# Release\n\nDepends on [[Roadmap]] and [setup](./setup.md).",
      "roadmap.md": "---\ntitle: Roadmap\n---\n\nPlan. Back to [[release]].",
      "setup.md": "# Setup guide\n\nSee [[Nowhere]].",
    });
    expect(backlinks["roadmap.md"].map((b) => [b.source, b.kind, b.context])).toEqual([["release.md", "wikilink", "Depends on Roadmap and setup."]]);
    expect(backlinks["setup.md"][0].source).toBe("release.md");
    expect(backlinks["release.md"][0].source).toBe("roadmap.md");
    expect(unresolved.map((u) => u.target)).toEqual(["Nowhere"]);
  });
});
