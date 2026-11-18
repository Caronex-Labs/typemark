/**
 * Built-in syntax, written ONLY against the public extension API (so they double as examples).
 *
 * Core (registered automatically, opt out with `coreExtensions: false`):
 *   @[title](url)        embed (YouTube, Vimeo, Loom, CodePen, Figma, audio/video files, any https page)
 *   [toc]                live table of contents
 *   > [!note] text       callout (Obsidian syntax): note, tip, info, success, warning, danger, bug, quote, todo
 *   /                    slash menu that TYPES markdown for you (teaches the syntax)
 *
 * Opt-in factories (behaviour supplied by the host app):
 *   wikilinks({...})     [[Page]] / [[Page|alias]] with open + autocomplete callbacks
 *   tags({...})          #tag with click + autocomplete
 *   mentions({...})      @name with click + autocomplete
 *   actionButtons({...}) ```button fenced widget: label / action / args → host onAction
 */
import type { Editor } from "./editor";
import type { Extension, SuggestItem } from "./extension";
import { buildEmbed, defaultEmbedPolicy, embedHtmlFor } from "./media";
import { fuzzy } from "./suggest";
import { toggleExtension } from "./fold";
import { linkCardExtension } from "./linkcard";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- @[title](url) embeds

export const embedExtension: Extension = {
  name: "embed",
  blocks: [
    {
      kind: "widget",
      name: "embed",
      pattern: /@\[([^\]]*)\]\((<[^>\n]*>|[^)\s]+)\)/,
      render({ el, match, editor }) {
        const raw = match![2].replace(/^<|>$/g, "");
        const node = buildEmbed(embedHtmlFor(raw), editor.embedPolicy ?? defaultEmbedPolicy);
        el.classList.add("md-embed");
        el.append(node);
        if (match![1]) {
          const cap = document.createElement("div");
          cap.className = "md-embed-caption";
          cap.textContent = match![1];
          el.append(cap);
        }
      },
    },
  ],
};

// ---------------------------------------------------------------- [toc]

export const tocExtension: Extension = {
  name: "toc",
  blocks: [
    {
      kind: "widget",
      name: "toc",
      pattern: /\[toc\]/i,
      live: true,
      render({ el, editor }) {
        const hs = editor.getHeadings();
        el.classList.add("md-toc");
        el.innerHTML = hs.length
          ? hs.map((h) => `<a class="md-toc-item" data-level="${h.level}" data-id="${h.id}">${esc(h.text)}</a>`).join("")
          : `<div class="md-toc-empty">Table of contents: add headings</div>`;
        const onClick = (e: MouseEvent) => {
          const a = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
          if (!a) return;
          e.preventDefault();
          e.stopPropagation();
          editor.revealBlock(a.dataset.id!);
        };
        el.addEventListener("mousedown", onClick);
        return () => el.removeEventListener("mousedown", onClick);
      },
    },
  ],
  css: `.tm-editor .md-toc{border-left:2px solid var(--tm-border);padding:.3em 0 .3em .9em;font-size:.92em}
.tm-editor .md-toc-item{display:block;color:var(--tm-accent);cursor:pointer;padding:.08em 0;text-decoration:none}
.tm-editor .md-toc-item:hover{text-decoration:underline}
.tm-editor .md-toc-item[data-level="2"]{padding-left:1em}.tm-editor .md-toc-item[data-level="3"]{padding-left:2em}
.tm-editor .md-toc-item[data-level="4"],.tm-editor .md-toc-item[data-level="5"],.tm-editor .md-toc-item[data-level="6"]{padding-left:3em}
.tm-editor .md-toc-empty{color:var(--tm-meta)}`,
};

// ---------------------------------------------------------------- > [!note] callouts

const CALLOUTS: Record<string, string> = {
  note: "✎", info: "ℹ", tip: "💡", success: "✓", question: "?", warning: "⚠", danger: "⚡", bug: "🐞", example: "▤", quote: "❝", todo: "☐", abstract: "≡",
};

export const calloutExtension: Extension = {
  name: "callout",
  blocks: [
    {
      kind: "prefix",
      name: "callout",
      prefix: /^> ?\[!(\w+)\][+-]? ?/,
      data(src) {
        const t = src.match(/^> ?\[!(\w+)\]/)![1].toLowerCase();
        return { callout: t, icon: CALLOUTS[t] ?? "✎" };
      },
      continuation: () => "> ",
    },
  ],
  css: `.tm-editor .md-custom[data-ext="callout"]{--c:#4183c4;background:color-mix(in srgb,var(--c) 10%,transparent);border-left:4px solid var(--c);border-radius:6px;padding:.6em .9em .6em 2.4em}
.tm-editor .md-custom[data-ext="callout"]::before{content:attr(data-icon);position:absolute;left:.8em;top:.6em;color:var(--c)}
.tm-editor .md-custom[data-callout="tip"],.tm-editor .md-custom[data-callout="success"]{--c:#2da44e}
.tm-editor .md-custom[data-callout="warning"],.tm-editor .md-custom[data-callout="question"],.tm-editor .md-custom[data-callout="todo"]{--c:#d4a72c}
.tm-editor .md-custom[data-callout="danger"],.tm-editor .md-custom[data-callout="bug"]{--c:#cf222e}
.tm-editor .md-custom[data-callout="example"],.tm-editor .md-custom[data-callout="abstract"]{--c:#8250df}
.tm-editor .md-custom[data-callout="quote"]{--c:#888}
.tm-editor .md-custom[data-ext="callout"] + .md-quote{margin-top:-.8em;background:color-mix(in srgb,#4183c4 6%,transparent)}`,
};

// ---------------------------------------------------------------- / slash menu (inserts syntax)

type Ins = { text: string; caret?: number; block?: boolean };
const SLASH: (Omit<SuggestItem, "apply"> & { ins: Ins })[] = [
  { icon: "H1", label: "Heading 1", detail: "# ", keywords: "title h1", ins: { text: "# " } },
  { icon: "H2", label: "Heading 2", detail: "## ", keywords: "subtitle h2", ins: { text: "## " } },
  { icon: "H3", label: "Heading 3", detail: "### ", keywords: "h3", ins: { text: "### " } },
  { icon: "•", label: "Bullet list", detail: "- ", keywords: "ul unordered", ins: { text: "- " } },
  { icon: "1.", label: "Numbered list", detail: "1. ", keywords: "ol ordered", ins: { text: "1. " } },
  { icon: "☐", label: "Task", detail: "- [ ] ", keywords: "todo checkbox", ins: { text: "- [ ] " } },
  { icon: "❝", label: "Quote", detail: "> ", keywords: "blockquote", ins: { text: "> " } },
  { icon: "ℹ", label: "Callout", detail: "> [!note] ", keywords: "admonition note tip warning", ins: { text: "> [!note] " } },
  { icon: "{}", label: "Code block", detail: "```lang ⏎", keywords: "fence snippet", ins: { text: "```\n\n```", caret: 3, block: true } },
  { icon: "∑", label: "Math block", detail: "$$ ⏎", keywords: "latex equation katex", ins: { text: "$$\n\n$$", caret: 3, block: true } },
  { icon: "◇", label: "Diagram", detail: "```mermaid", keywords: "mermaid flowchart chart graph", ins: { text: "```mermaid\ngraph TD\n  A --> B\n```", caret: 11, block: true } },
  { icon: "▦", label: "Table", detail: "| a | b | ⏎", keywords: "grid columns", ins: { text: "| Column | Column |\n| --- | --- |\n|   |   |", caret: 2, block: true } },
  { icon: "🖼", label: "Image", detail: "![](url) · ⏎ to upload", keywords: "picture photo upload", ins: { text: "![]()", caret: 4 } },
  { icon: "▶", label: "Embed", detail: "@[](url)", keywords: "video youtube iframe vimeo loom", ins: { text: "@[]()", caret: 4 } },
  { icon: "🔗", label: "Link card", detail: "https://… alone on a line", keywords: "bookmark url preview link", ins: { text: "https://", block: true } },
  { icon: "▸", label: "Toggle", detail: "+++ Title ⏎ … +++", keywords: "collapse details fold toggle", ins: { text: "+++ " } },
  { icon: "≡", label: "Table of contents", detail: "[toc]", keywords: "outline toc", ins: { text: "[toc]" } },
  { icon: "—", label: "Divider", detail: "---", keywords: "hr rule separator", ins: { text: "---", block: true } },
  { icon: "¹", label: "Footnote", detail: "[^1]", keywords: "reference note", ins: { text: "[^1]" } },
  { icon: "✦", label: "Ask AI to write here", detail: "@ai ", keywords: "ai agent instruction generate prompt", ins: { text: "@ai " } },
];

/** Slash menu. Every item inserts the markdown it stands for; `extra` items from the host are appended. */
export function slashMenu(extra: SuggestItem[] = []): Extension {
  const base: SuggestItem[] = SLASH.map(({ ins, ...it }) => ({
    ...it,
    apply: ({ editor }: { editor: Editor }) => {
      const st = editor.getBlocks().find((b) => b.id === editor.caretBlockId());
      if (ins.block && st && st.src.trim() !== "") {
        editor.exec({ type: "insertBlock", src: ins.text, caret: ins.caret });
      } else editor.exec({ type: "insertText", text: ins.text, caret: ins.caret });
    },
  }));
  return {
    name: "slash",
    suggesters: [{ name: "slash", trigger: "/", items: (q) => fuzzy([...base, ...extra], q) }],
  };
}

// ---------------------------------------------------------------- @ai instructions

/**
 * `@ai <instruction>` or `@ai(agent) <instruction>`: a block addressed to an AI agent.
 * It stays in the markdown until the host's agent replaces it (see editor.ai.onInstruction).
 */
export const INSTRUCTION = /^@ai(?:\(([\w-]+)\))?:? /;

export const instructionExtension: Extension = {
  name: "instruction",
  blocks: [
    {
      kind: "prefix",
      name: "instruction",
      prefix: INSTRUCTION,
      data: (src) => ({ agent: src.match(INSTRUCTION)?.[1] ?? "ai" }),
      continuation: () => null,
    },
  ],
};

export const coreExtensions: Extension[] = [embedExtension, tocExtension, calloutExtension, instructionExtension, toggleExtension, linkCardExtension, slashMenu()];

// ---------------------------------------------------------------- opt-in: [[wikilinks]], #tags, @mentions

export interface LinkerOptions {
  /** Called on Cmd/Ctrl-click (plain click when `plainClick`). */
  onOpen?(target: string, ctx: { editor: Editor; event: MouseEvent }): void;
  /** Autocomplete candidates for the query. */
  suggest?(query: string): string[] | Promise<string[]>;
  /** Mark unresolved targets (adds class md-x-missing). */
  exists?(target: string): boolean;
  plainClick?: boolean;
}

export function wikilinks(o: LinkerOptions = {}): Extension {
  return {
    name: "wikilinks",
    inline: [
      {
        name: "wikilink",
        trigger: "[[",
        pattern: /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/,
        parts: (m) =>
          m[2]
            ? [{ text: "[[" + m[1] + "|", meta: true }, { text: m[2] }, { text: "]]", meta: true }]
            : [{ text: "[[", meta: true }, { text: m[1] }, { text: "]]", meta: true }],
        data: (m) => ({ target: m[1].trim() }),
        modClick: !o.plainClick,
        onClick: (d, ctx) => o.onOpen?.(d.target, ctx),
        decorate: (el, d) => {
          el.title = d.target;
          if (o.exists && !o.exists(d.target)) el.classList.add("md-x-missing");
        },
      },
    ],
    suggesters: o.suggest
      ? [
          {
            name: "wikilink",
            trigger: "[[",
            boundary: false,
            items: async (q) => (await o.suggest!(q)).map((t) => ({ label: t, icon: "↗", apply: `[[${t}]]` })),
          },
        ]
      : [],
    css: `.tm-editor .md-x-wikilink{color:var(--tm-accent);cursor:text}.tm-editor .md-x-wikilink:hover{text-decoration:underline}.tm-editor .md-x-wikilink.md-x-missing{opacity:.6;text-decoration:underline dotted}`,
  };
}

function pill(name: string, sigil: string, word: string, o: LinkerOptions): Extension {
  return {
    name: name + "s",
    inline: [
      {
        name,
        trigger: sigil,
        pattern: new RegExp(`${sigil.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${word})`, "u"),
        accept: (_m, src, at) => at === 0 || /[\s(]/.test(src[at - 1]),
        parts: (m) => [{ text: sigil, meta: false }, { text: m[1] }],
        data: (m) => ({ value: m[1] }),
        modClick: !o.plainClick,
        onClick: (d, ctx) => o.onOpen?.(d.value, ctx),
      },
    ],
    suggesters: o.suggest
      ? [{ name, trigger: sigil, items: async (q) => (await o.suggest!(q)).map((t) => ({ label: sigil + t, apply: sigil + t + " " })) }]
      : [],
    css: `.tm-editor .md-x-${name}{background:color-mix(in srgb,var(--tm-accent) 14%,transparent);color:var(--tm-accent);border-radius:1em;padding:0 .45em;font-size:.92em}`,
  };
}

export const tags = (o: LinkerOptions = {}) => pill("tag", "#", "[\\p{L}\\p{N}_/-]*[\\p{L}_/-][\\p{L}\\p{N}_/-]*", o);
export const mentions = (o: LinkerOptions = {}) => pill("mention", "@", "[\\w.-]+", o);

// ---------------------------------------------------------------- opt-in: ```button action widgets

export interface ButtonSpec {
  label: string;
  action: string;
  /** Any other `key: value` lines. */
  args: Record<string, string>;
}

/**
 * ```button
 * label: Deploy preview
 * action: deploy
 * env: staging
 * ```
 * The engine draws the button; YOUR onAction decides what it does.
 */
export function actionButtons(o: { onAction(spec: ButtonSpec, ctx: { editor: Editor; blockId: string }): void | Promise<void> }): Extension {
  return {
    name: "buttons",
    blocks: [
      {
        kind: "widget",
        name: "button",
        fence: "button",
        render({ el, body, editor, blockId }) {
          const args: Record<string, string> = {};
          for (const line of body.split("\n")) {
            const m = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
            if (m) args[m[1]] = m[2].trim();
          }
          const { label = "Button", action = "", ...rest } = args;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "md-action-button";
          btn.textContent = label;
          btn.addEventListener("mousedown", (e) => e.stopPropagation());
          btn.addEventListener("click", async (e) => {
            e.preventDefault();
            btn.disabled = true;
            try {
              await o.onAction({ label, action, args: rest }, { editor, blockId });
            } finally {
              btn.disabled = false;
            }
          });
          el.append(btn);
        },
      },
    ],
    css: `.tm-editor .md-action-button{font:inherit;font-weight:600;padding:.45em 1.1em;border-radius:8px;border:1px solid color-mix(in srgb,var(--tm-accent) 60%,transparent);background:color-mix(in srgb,var(--tm-accent) 14%,transparent);color:var(--tm-accent);cursor:pointer;transition:background .15s}
.tm-editor .md-action-button:hover{background:color-mix(in srgb,var(--tm-accent) 24%,transparent)}.tm-editor .md-action-button:disabled{opacity:.6;cursor:progress}`,
  };
}
