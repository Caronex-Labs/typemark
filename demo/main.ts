import { actionButtons, createEditor, mentions, mermaidRenderer, registerExtension, tags, wikilinks } from "../src/index";
import sample from "./sample.md?raw";

// ---- host-side behaviour: the engine only knows syntax; the app decides what things do
const notes = ["Project ideas", "Reading list", "Meeting notes", "Roadmap", "Daily log"];
const people = ["sam", "alex", "jordan", "riley"];
const toast = (msg: string) => {
  const t = document.createElement("div");
  t.className = "toast";
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
  ai: {
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
  store.set("tm-theme", theme);
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

// ---- mock docs agent: the engine provides the review views; this fake "AI" just drives the API
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (needle: string) => {
  const i = ed.getMarkdown().indexOf(needle);
  return i < 0 ? null : { from: i, to: i + needle.length };
};
async function stream(write: (chunk: string) => void, text: string) {
  for (const w of text.match(/\S+\s*/g) ?? []) {
    write(w);
    await sleep(28);
  }
}
const reviewBtn = $<HTMLButtonElement>("#t-review");
reviewBtn.onclick = async () => {
  if (reviewBtn.getAttribute("aria-busy") === "true") return;
  reviewBtn.setAttribute("aria-busy", "true");
  const agent = "Docs agent";
  try {
    const retry = at("retries failed requests 3 times and waits 10 seconds between attempts");
    if (retry) {
      await sleep(400);
      ed.ai.suggestEdit(retry.from, retry.to, "retries failed requests 5 times and waits 2 seconds between attempts", {
        author: agent,
        reason: "Checked `src/retry.ts`: `MAX_RETRIES = 5`, `BACKOFF_MS = 2000`.",
      });
    }
    const cache = at("Results are cached for an hour in `~/.cache/tool`.");
    if (cache) {
      await sleep(500);
      const id = ed.ai.addNote({
        ...cache,
        kind: "question",
        author: agent,
        body: "",
        streaming: true,
        replyPlaceholder: "Answer the agent…",
        onReply: async (answer, note) => {
          await sleep(500);
          ed.ai.addReply(note.id, { author: agent, body: `Got it, “${answer}”. I'll suggest wording that matches the code.` });
          const c = at("Results are cached for an hour in `~/.cache/tool`.");
          if (c)
            ed.ai.suggestEdit(c.from, c.to, "Results are cached for 15 minutes in `$XDG_CACHE_HOME/tool`.", {
              author: agent,
              reason: "From `src/cache.ts` and your answer.",
            });
          updateReview();
        },
      });
      await stream(
        (w) => ed.ai.appendNote(id, w),
        "I couldn't confirm this. `src/cache.ts` uses `$XDG_CACHE_HOME/tool` with a **15 minute** TTL, and I found no `~/.cache/tool` path. Is the doc describing an older version, or a setting I'm missing?",
      );
      ed.ai.updateNote(id, { status: "ready" });
    }
    const sync = at("Run `tool sync --all` to sync every project in the workspace.");
    if (sync) {
      await sleep(400);
      ed.ai.addNote({
        ...sync,
        kind: "issue",
        author: agent,
        body: "`sync` has no `--all` flag (see `src/commands/sync.ts`); it syncs every project by default. Running the documented command fails with *unknown option*.",
        actions: [
          {
            label: "Apply fix",
            primary: true,
            run: (note, { review, editor }) => {
              const flag = editor.getMarkdown().indexOf(" --all", note.from);
              if (flag >= 0) review.suggest({ from: flag, to: flag + 6, text: "", author: agent, reason: "Remove the nonexistent flag." });
              review.removeNote(note.id);
              updateReview();
            },
          },
          { label: "Open code", run: () => toast("Host app would open src/commands/sync.ts") },
        ],
      });
      await sleep(400);
      const h = ed.ai.suggestBlocks(sync.to, "", { streaming: true, author: agent, reason: "The code also requires a logged-in workspace." });
      await stream(h.append, "> [!note] `tool sync` needs a signed-in workspace. Run `tool login` first.");
      h.finish();
    }
    if (!retry && !cache && !sync) toast("Nothing to review: restore the sample document first");
  } finally {
    reviewBtn.removeAttribute("aria-busy");
    updateReview();
  }
};

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
for (const b of document.querySelectorAll<HTMLElement>(".review button, #t-review")) b.addEventListener("mousedown", (e) => e.preventDefault());
