import { actionButtons, connectAgent, createEditor, mentions, mermaidRenderer, registerExtension, tags, wikilinks } from "../src/index";
import type { Thread, Unit } from "../src/index";
import sample from "./sample.md?raw";

// ---- host-side behaviour: the engine only knows syntax; the app decides what things do
const notes = ["Project ideas", "Reading list", "Meeting notes", "Roadmap", "Daily log"];
const people = ["sam", "alex", "jordan", "riley"];
const toast = (msg: string) => {
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.classList.add("out"), 1800);
  setTimeout(() => t.remove(), 2200);
};
const filter = (list: string[], q: string) => {
  const l = q.toLowerCase();
  const rank = (x: string) => (x.toLowerCase().startsWith(l) ? 0 : x.toLowerCase().split(/\s+/).some((w) => w.startsWith(l)) ? 1 : 2);
  return list.filter((x) => x.toLowerCase().includes(l)).sort((a, b) => rank(a) - rank(b));
};

registerExtension(
  wikilinks({
    onOpen: (t) => toast(`Open note “${t}”`),
    exists: (t) => notes.includes(t),
    suggest: (q) => filter(notes, q),
  }),
);
registerExtension(tags({ onOpen: (t) => toast(`Search #${t}`), suggest: (q) => filter(["inbox", "idea", "todo", "later"], q) }));
registerExtension(mentions({ onOpen: (p) => toast(`Profile @${p}`), suggest: (q) => filter(people, q) }));
registerExtension(
  actionButtons({
    onAction: async ({ action, label }, { editor }) => {
      if (action === "timestamp") editor.exec({ type: "insertBlock", src: `> [!note] ${new Date().toLocaleString()}` });
      else toast(`${label}: no handler for “${action}”`);
    },
  }),
);

// ---- editor
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const ed = createEditor($("#editor"), {
  value: store.get("tm-doc") ?? sample,
  placeholder: "Start writing…  (type / for syntax)",
  renderers: { mermaid: mermaidRenderer(() => import("mermaid")) },
  // mock link-card metadata: a real app would call its own unfurl endpoint
  linkPreview: async (url) => {
    await new Promise((r) => setTimeout(r, 400));
    const host = new URL(url).host;
    return { title: host === "github.com" ? "GitHub" : host, description: `Preview of ${url} supplied by the host app.`, siteName: host };
  },
  ai: {
    settleMs: 2500,
    onUnitSettled: (unit) => void reviewUnit(unit),
    // mock agent: a real app would send job.instruction + job.context to its model / tools
    onInstruction: async (job) => {
      await new Promise((r) => setTimeout(r, 700));
      if (/diagram|chart|flow/i.test(job.instruction)) {
        const h = job.stream({ reason: "Drawn from the paragraphs above." });
        const out = "```mermaid\nsequenceDiagram\n  participant CLI\n  participant API\n  CLI->>API: request\n  API--xCLI: failure\n  Note over CLI: wait, then retry\n  CLI->>API: retry (up to the limit)\n  API-->>CLI: success\n```";
        for (const line of out.split(/(?<=\n)/)) {
          h.append(line);
          await new Promise((r) => setTimeout(r, 90));
        }
        h.finish();
      } else if (job.agent === "research") {
        job.ask(`Before I research “${job.instruction}”, which time range should I cover?`, async (answer) => {
          await new Promise((r) => setTimeout(r, 600));
          job.resolve(`> [!info] Research summary (${answer})\n\n- Finding one, with a source link\n- Finding two, with a source link`, { reason: "Mock research agent" });
        });
      } else {
        const h = job.stream();
        for (const w of `Here is a draft for: ${job.instruction}. A real agent would write this using the surrounding section as context.`.split(/(?<= )/)) {
          h.append(w);
          await new Promise((r) => setTimeout(r, 30));
        }
        h.finish();
      }
      updateReview();
    },
  },
  onChange: (md) => {
    store.set("tm-doc", md);
    refresh(md);
    setSaved();
  },
});
(window as unknown as { editor: typeof ed }).editor = ed;

function refresh(md = ed.getMarkdown()) {
  const fm = ed.getFrontmatter()?.data.title;
  const h = ed.getHeadings()[0]?.text;
  $("#title").textContent = (typeof fm === "string" && fm) || h || "Untitled";
  const st = ed.getStats();
  $("#stats").textContent = `${st.words.toLocaleString()} words · ${st.readingMinutes} min read`;
}
let savedTimer = 0;
function setSaved() {
  const s = $("#saved");
  s.dataset.state = "saving";
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (s.dataset.state = "saved"), 400);
}
refresh();

// ---- top bar toggles (view settings only; writing is all markdown)
const toggle = (id: string, on: (v: boolean) => void, initial = false) => {
  const b = $<HTMLButtonElement>(id);
  let v = initial;
  const apply = () => {
    b.setAttribute("aria-pressed", String(v));
    on(v);
  };
  b.onclick = () => {
    v = !v;
    apply();
  };
  apply();
};
toggle("#t-source", (v) => ed.setSourceMode(v));
toggle("#t-focus", (v) => ed.setFocusMode(v));

const themes = ["auto", "light", "dark"] as const;
let theme = (store.get("tm-theme") as (typeof themes)[number]) ?? "auto";
const applyTheme = () => {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("#t-theme").dataset.theme = theme;
  $("#t-theme").title = `Theme: ${theme}`;
  $("#t-theme").setAttribute("aria-label", `Theme: ${theme}`);
  store.set("tm-theme", theme);
  ed.refresh(); // diagrams pick their theme at render time
};
$("#t-theme").onclick = () => {
  theme = themes[(themes.indexOf(theme) + 1) % themes.length];
  applyTheme();
};
applyTheme();

$("#t-reset").onclick = () => {
  ed.setMarkdown(sample);
  store.set("tm-doc", sample);
  refresh();
  toast("Sample document restored");
};

// ---- mock docs agent. The ENGINE only reports activity (onUnitSettled) and shows threads;
// the APP decides the cadence (here: every block when the writer leaves it, plus once on open)
// and what the agent does. A real app would call its model with unit.markdown + thread.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AGENT = "Docs agent";
async function stream(write: (chunk: string) => void, text: string) {
  for (const w of text.match(/\S+\s*/g) ?? []) {
    write(w);
    await sleep(25);
  }
}
const has = (thread: Thread | null, needle: string) => !!thread?.history.some((e) => e.text.includes(needle));

async function reviewUnit(unit: Unit) {
  const thread = ed.ai.getThread(unit.id); // the agent sees everything already said about this block
  const md = unit.markdown;
  const off = (needle: string) => unit.from + md.indexOf(needle);
  await sleep(350);
  if (/retries failed requests 3 times and waits 10 seconds/.test(md) && !has(thread, "5 times")) {
    const f = off("3 times");
    ed.ai.suggestEdit(f, f + "3 times and waits 10 seconds".length, "5 times and waits 2 seconds", {
      author: AGENT,
      reason: "Checked `src/retry.ts`: `MAX_RETRIES = 5`, `BACKOFF_MS = 2000`.",
    });
  }
  if (md.includes("cached for an hour") && !has(thread, "XDG_CACHE_HOME")) {
    const f = off("cached for an hour");
    const id = ed.ai.addNote({
      from: f,
      to: f + 18,
      kind: "question",
      author: AGENT,
      body: "",
      streaming: true,
      replyPlaceholder: "Answer the agent…",
      onReply: async (answer, note) => {
        await sleep(500);
        ed.ai.addReply(note.id, { author: AGENT, body: `Thanks. Suggesting wording that matches the code (“${answer}”).` });
        const u = ed.ai.unitAt(note.from)!;
        const g = u.from + u.markdown.indexOf("an hour in `~/.cache/tool`");
        if (g >= u.from) ed.ai.suggestEdit(g, g + "an hour in `~/.cache/tool`".length, "15 minutes in `$XDG_CACHE_HOME/tool`", { author: AGENT, reason: "From `src/cache.ts` and your answer." });
        updateReview();
      },
    });
    await stream((w) => ed.ai.appendNote(id, w), "I couldn't confirm this. `src/cache.ts` uses `$XDG_CACHE_HOME/tool` with a **15 minute** TTL. Is the doc describing an older version?");
    ed.ai.updateNote(id, { status: "ready" });
  }
  if (md.includes("tool sync --all") && !has(thread, "--all")) {
    const f = off("tool sync --all");
    ed.ai.addNote({
      from: f,
      to: f + 15,
      kind: "issue",
      author: AGENT,
      body: "`sync` has no `--all` flag (`src/commands/sync.ts`); it syncs every project by default.",
      actions: [
        {
          label: "Apply fix",
          primary: true,
          run: (note, { review, editor }) => {
            const i = editor.getMarkdown().indexOf(" --all", note.from);
            if (i >= 0) review.suggest({ from: i, to: i + 6, text: "", author: AGENT, reason: "Remove the nonexistent flag." });
            review.removeNote(note.id);
            updateReview();
          },
        },
        { label: "Open code", run: () => toast("The host app would open src/commands/sync.ts") },
      ],
    });
  }
  // new writing: a light generic pass so per-block review is visible on anything you type
  const words = md.match(/\b(very|really|basically|just)\b/gi);
  if (words && !has(thread, "Filler word")) {
    const m = md.match(/\b(very|really|basically|just)\b/i)!;
    ed.ai.setMarks(`style:${unit.id}`, [{ from: unit.from + m.index!, to: unit.from + m.index! + m[0].length, severity: "style", message: "Filler word: consider cutting it.", fixes: [{ label: "Remove", text: "" }] }]);
  }
  if (/\b(always|never)\b/i.test(md) && !has(thread, "Is this absolute")) {
    const m = md.match(/\b(always|never)\b/i)!;
    ed.ai.addNote({ from: unit.from + m.index!, to: unit.from + m.index! + m[0].length, kind: "question", author: AGENT, body: "Is this absolute? The code may have exceptions.", onReply: (a, n) => ed.ai.addReply(n.id, { author: AGENT, body: "Noted." }) });
  }
  updateReview();
}

// app-side cadence: review the AI section on open; afterwards every block the writer finishes
setTimeout(() => {
  for (const u of ed.ai.getUnits()) if (/retries failed|cached for an hour|tool sync --all/.test(u.markdown)) void reviewUnit(u);
}, 900);

function updateReview() {
  const n = ed.ai.getSuggestions().length;
  const notes = ed.ai.getNotes().length;
  $("#review-pill").hidden = n === 0;
  document.body.classList.toggle("reviewing", n > 0);
  $("#r-count").textContent = `${n} suggestion${n === 1 ? "" : "s"}${notes ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""}`;
}
$("#r-next").onclick = () => (ed.ai.next(1), updateReview());
$("#r-prev").onclick = () => (ed.ai.next(-1), updateReview());
$("#r-accept").onclick = () => (ed.ai.acceptAll(), updateReview());
$("#r-reject").onclick = () => (ed.ai.rejectAll(), updateReview());
ed.root.addEventListener("click", () => setTimeout(updateReview, 0));
for (const b of document.querySelectorAll<HTMLElement>(".review button")) b.addEventListener("mousedown", (e) => e.preventDefault());

// ---- live agent bridge: if the typemark MCP server (Claude Code plugin) is running,
// Claude can review this page. Harmless when nothing is listening (it just retries).
const dot = document.createElement("span");
dot.id = "agent-status";
dot.title = "Agent bridge";
document.querySelector(".bar .spacer")?.after(dot);
const bridge = connectAgent(ed, {
  docId: "demo",
  onStatus: (s) => {
    dot.dataset.status = s;
    dot.textContent = s === "connected" ? "Claude connected" : "";
    dot.title = `Agent bridge: ${s}`;
  },
});
(window as unknown as { bridge: typeof bridge }).bridge = bridge;
