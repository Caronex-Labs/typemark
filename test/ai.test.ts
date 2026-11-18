import { describe, expect, it, vi } from "vitest";
import { createEditor, diffWords } from "../src/index";
import { sourceText } from "../src/caret";

const mount = (value: string, opts = {}) => {
  const el = document.createElement("div");
  document.body.append(el);
  return { el, ed: createEditor(el, { value, ...opts }) };
};

describe("diffWords", () => {
  it("finds minimal word hunks", () => {
    const a = "The timeout is 10 seconds by default.";
    const b = "The timeout is 30 seconds by default.";
    expect(diffWords(a, b)).toEqual([{ from: 15, to: 17, text: "30" }]);
  });
  it("merges neighbours across one space", () => {
    expect(diffWords("a big red dog", "a small blue dog")).toEqual([{ from: 2, to: 9, text: "small blue" }]);
  });
});

describe("suggested edits", () => {
  it("granular suggestEdit: phantom text, document untouched until accepted", () => {
    const { el, ed } = mount("Retries happen 3 times with a 10s timeout.");
    const hs = ed.ai.suggestEdit(0, ed.getMarkdown().length, "Retries happen 5 times with a 30s timeout.", { reason: "Matches `client.ts`" });
    expect(hs.length).toBe(2);
    expect(ed.getMarkdown()).toBe("Retries happen 3 times with a 10s timeout.");
    expect([...el.querySelectorAll(".tm-ins")].map((x) => x.textContent)).toEqual(["5", "30s"]);
    // the phantom text never leaks into the source
    expect(sourceText(el.children[0] as HTMLElement)).toBe(ed.getMarkdown());
    hs[1].accept();
    expect(ed.getMarkdown()).toBe("Retries happen 3 times with a 30s timeout.");
    // remaining suggestion still points at "3"
    const [s] = ed.ai.getSuggestions();
    expect(ed.getMarkdown().slice(s.from, s.to)).toBe("3");
    s && ed.ai.reject(s.id);
    expect(ed.ai.getSuggestions()).toEqual([]);
  });

  it("acceptAll is one undo step", () => {
    const { ed } = mount("one two three");
    ed.ai.suggestEdit(0, 13, "uno two tres");
    ed.ai.acceptAll();
    expect(ed.getMarkdown()).toBe("uno two tres");
    ed.undo();
    expect(ed.getMarkdown()).toBe("one two three");
  });

  it("anchors follow edits elsewhere; editing the target makes the suggestion stale", () => {
    const onStale = vi.fn();
    const { ed } = mount("alpha\n\nbeta gamma", { ai: { onStale } });
    const g = ed.getMarkdown().indexOf("gamma");
    const [h] = ed.ai.suggestEdit(g, g + 5, "delta");
    ed.replaceDoc(0, 0, "NEW ");
    const s = h.get()!;
    expect(ed.getMarkdown().slice(s.from, s.to)).toBe("gamma");
    ed.replaceDoc(s.from, s.from + 1, "G");
    expect(onStale).toHaveBeenCalled();
    expect(ed.ai.getSuggestions()).toEqual([]);
  });

  it("block suggestions stream into a phantom block and insert on accept", () => {
    const { el, ed } = mount("# Install\n\nRun the installer.");
    const h = ed.ai.suggestBlocks(5, "", { streaming: true, author: "Docs agent" });
    h.append("- Requires Node 22\n");
    h.append("- Run `npm i`");
    h.finish();
    ed.ai.render();
    const ph = el.querySelector(".tm-phantom-suggestion")!;
    expect(ph.previousElementSibling!.textContent).toContain("Install");
    expect(ph.querySelectorAll(".md-ul").length).toBe(2);
    h.accept();
    expect(ed.getMarkdown()).toBe("# Install\n\n- Requires Node 22\n- Run `npm i`\n\nRun the installer.");
  });
});

describe("notes (agent questions / issues)", () => {
  it("renders after the anchored block, with reply + actions, never in the markdown", async () => {
    const onReply = vi.fn();
    const run = vi.fn();
    const { el, ed } = mount("Intro.\n\nThe CLI caches results for an hour.\n\nOutro.");
    const md = ed.getMarkdown();
    const from = md.indexOf("caches");
    const id = ed.ai.addNote({
      from,
      to: from + "caches results for an hour".length,
      kind: "question",
      author: "Code checker",
      body: "I can't find a cache in `src/cli.ts`. Is this the `--cache` flag?",
      onReply,
      actions: [{ label: "Open code", run }],
    });
    const note = el.querySelector<HTMLElement>(`.tm-ph-section[data-id="${id}"]`)!;
    const card = note.closest<HTMLElement>(".tm-phantom")!;
    expect(card.previousElementSibling!.textContent).toContain("caches results");
    expect(note.querySelector("code")!.textContent).toContain("src/cli.ts");
    expect(ed.getMarkdown()).toBe(md);
    const ta = card.querySelector("textarea")!;
    ta.value = "Yes, --cache";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await Promise.resolve();
    expect(onReply).toHaveBeenCalledWith("Yes, --cache", expect.objectContaining({ id }));
    ed.ai.addReply(id, { author: "Code checker", body: "Thanks, updated." });
    expect(el.querySelectorAll(`.tm-ph-section[data-id="${id}"] .tm-ph-reply`).length).toBe(2);
    [...el.querySelectorAll<HTMLButtonElement>(`.tm-ph-section[data-id="${id}"] .tm-btn`)].find((b) => b.textContent === "Open code")!.click();
    expect(run).toHaveBeenCalled();
    // typing elsewhere keeps the note anchored
    ed.replaceDoc(0, 0, "Hello. ");
    const n = ed.ai.getNotes()[0];
    expect(ed.getMarkdown().slice(n.from, n.to)).toBe("caches results for an hour");
  });
});

describe("comments and marks", () => {
  it("comments track edits and re-anchor by quote", () => {
    const { ed } = mount("Use the staging endpoint for tests.");
    const id = ed.ai.addComment({ from: 8, to: 24 });
    ed.replaceDoc(0, 0, "Always ");
    expect(ed.ai.getComments()[0].quote).toBe("staging endpoint");
    const saved = ed.ai.getComments();
    const other = mount("Note: Use the staging endpoint for tests.").ed;
    expect(other.ai.restoreComments(saved)).toEqual([]);
    const c = other.ai.getComments()[0];
    expect(other.getMarkdown().slice(c.from, c.to)).toBe("staging endpoint");
    expect(c.id).toBe(id);
  });

  it("marks: fixes apply as edits; overlapping edits clear them", () => {
    const { ed } = mount("Teh quick fox.");
    ed.ai.setMarks("spell", [{ from: 0, to: 3, severity: "error", message: "Typo", fixes: [{ label: "The", text: "The" }] }]);
    expect(ed.ai.getMarks().length).toBe(1);
    ed.replaceDoc(0, 3, "The");
    expect(ed.ai.getMarks().length).toBe(0);
  });

  it("markAccepted tints accepted text", () => {
    const { ed } = mount("a b", { ai: { markAccepted: true } });
    ed.ai.suggest({ from: 3, text: " c" }).accept();
    expect(ed.ai.getAuthored()).toEqual([{ from: 4, to: 5 }]);
  });

  it("getContext gives prompt context with the heading path", () => {
    const { ed } = mount("# API\n\n## Auth\n\nTokens expire.");
    const ctx = ed.ai.getContext({ from: 16, to: 22 });
    expect(ctx.selection).toBe("Tokens");
    expect(ctx.headingPath).toEqual(["API", "Auth"]);
  });
});

describe("@ai instructions", () => {
  it("parses, runs on Enter, and is replaced by the agent's result", async () => {
    const seen: string[] = [];
    const { el, ed } = mount("Intro paragraph.\n\n@ai(diagram) Explain the paragraph above as a diagram\n\nOutro.", {
      ai: {
        onInstruction: (job: import("../src/ai").InstructionJob) => {
          seen.push(`${job.agent}:${job.instruction}:${job.context.before.trim()}`);
          job.resolve("```mermaid\ngraph LR\n  A --> B\n```", { reason: "From the intro" });
        },
      },
    });
    const b = el.children[1] as HTMLElement;
    expect(b.dataset.ext).toBe("instruction");
    expect(b.dataset.agent).toBe("diagram");
    expect(ed.ai.getInstructions()[0]).toMatchObject({ agent: "diagram", instruction: "Explain the paragraph above as a diagram", status: "idle" });
    const id = ed.ai.runInstruction(ed.ai.getInstructions()[0].from);
    expect(id).toBeTruthy();
    expect(seen[0]).toBe("diagram:Explain the paragraph above as a diagram:Intro paragraph.");
    expect(ed.ai.getInstructions()[0].status).toBe("done");
    const [s] = ed.ai.getSuggestions();
    expect(s.display).toBe("block");
    expect(ed.getMarkdown()).toContain("@ai(diagram)");
    s && ed.ai.accept(s.id);
    expect(ed.getMarkdown()).toBe("Intro paragraph.\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nOutro.");
  });

  it("autoApplyInstructions replaces directly; failures are shown on the block", () => {
    const { el, ed } = mount("@ai write a haiku", {
      ai: { autoApplyInstructions: true, onInstruction: (j: import("../src/ai").InstructionJob) => j.resolve("Old pond, frog jumps in.") },
    });
    ed.ai.runInstructions();
    expect(ed.getMarkdown()).toBe("Old pond, frog jumps in.");
    const other = mount("@ai do it", { ai: { onInstruction: (j: import("../src/ai").InstructionJob) => j.fail("quota") } });
    other.ed.ai.runInstructions();
    expect((other.el.children[0] as HTMLElement).dataset.aiStatus).toBe("error");
    expect(el.querySelector("[data-ai-status]")).toBeNull();
  });
});

describe("threads: one per unit", () => {
  it("everything on a paragraph lands in one thread; agents can read it", () => {
    const { el, ed } = mount("Alpha beta gamma.\n\nOther paragraph.");
    ed.ai.suggestEdit(0, 17, "Alpha BETA gamma.", { author: "Style agent" });
    ed.ai.addNote({ from: 6, to: 10, kind: "question", author: "Fact agent", body: "Is beta right?" });
    ed.ai.addNote({ from: 0, to: 5, kind: "issue", author: "Style agent", body: "Alpha is vague." });
    const t = ed.ai.getThread(3)!;
    expect(t.open.suggestions.length).toBe(1);
    expect(t.open.notes.map((n) => n.author)).toEqual(["Style agent", "Fact agent"]);
    expect(t.history.map((e) => e.type)).toEqual(["suggestion", "note", "note"]);
    // ONE card for the unit, holding both notes
    expect(el.querySelectorAll(".tm-phantom").length).toBe(1);
    expect(el.querySelectorAll(".tm-phantom .tm-ph-section").length).toBe(2);
    expect(ed.ai.getThread(25)).toBeNull();
    ed.ai.reject(t.open.suggestions[0].id);
    expect(ed.ai.getThread(3)!.history.map((e) => e.type)).toEqual(["suggestion", "note", "note", "rejected"]);
  });

  it("a list (with nested items) is one unit and one thread", () => {
    const { ed } = mount("Intro.\n\n- one\n  - one.a\n- two\n\nOutro.");
    const units = ed.ai.getUnits();
    expect(units.map((u) => u.markdown)).toEqual(["Intro.", "- one\n  - one.a\n- two", "Outro."]);
    const md = ed.getMarkdown();
    ed.ai.addNote({ from: md.indexOf("one.a"), to: md.indexOf("one.a") + 5, kind: "info", body: "a" });
    ed.ai.addComment({ from: md.indexOf("two"), to: md.indexOf("two") + 3 });
    const t = ed.ai.getThread(md.indexOf("- one"))!;
    expect(t.history.map((e) => e.type)).toEqual(["note", "comment"]);
    expect(ed.ai.getThreads().length).toBe(1);
  });

  it("merging two paragraphs merges their threads", () => {
    const { ed } = mount("First.\n\nSecond.");
    ed.ai.addNote({ from: 0, to: 5, kind: "info", body: "on first" });
    ed.ai.addNote({ from: 8, to: 14, kind: "info", body: "on second" });
    expect(ed.ai.getThreads().length).toBe(2);
    ed.replaceDoc(6, 8, " ");
    expect(ed.ai.getThreads().length).toBe(1);
    expect(ed.ai.getThreads()[0].history.length).toBe(2);
  });
});

describe("review cadence", () => {
  it("dirty units + settle on idle", async () => {
    vi.useFakeTimers();
    const settled: string[] = [];
    const { ed } = mount("One.\n\nTwo.", { ai: { settleMs: 100, onUnitSettled: (u: import("../src/ai").Unit, c: { reason: string }) => settled.push(`${u.markdown}:${c.reason}`) } });
    ed.ai; // attach the layer
    ed.replaceDoc(4, 4, " more", "type");
    expect(ed.ai.getDirtyUnits().map((u) => u.markdown)).toEqual(["One. more"]);
    vi.advanceTimersByTime(150);
    expect(settled).toEqual(["One. more:idle"]);
    expect(ed.ai.getDirtyUnits()).toEqual([]);
    // AI edits do not count as writing
    ed.ai.suggest({ from: 0, to: 3, text: "Uno" }).accept();
    expect(ed.ai.getDirtyUnits()).toEqual([]);
    vi.useRealTimers();
  });
});

it("Enter at the end of a paragraph does not move the next paragraph's thread", () => {
  const { ed } = mount("Intro.\n\nTarget paragraph.");
  ed.ai.addNote({ from: 8, to: 14, kind: "info", body: "on target" });
  ed.replaceDoc(6, 6, "\n\nNew words.");
  expect(ed.ai.getThread(ed.getMarkdown().indexOf("New"))).toBeNull();
  expect(ed.ai.getThread(ed.getMarkdown().indexOf("Target"))!.history.length).toBe(1);
});
