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
