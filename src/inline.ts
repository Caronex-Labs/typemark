/**
 * Inline markdown -> HTML.
 *
 * Core invariant (the whole editing model depends on it):
 *   textContent(renderInline(src)) === src
 * Markdown syntax characters are never dropped; they are wrapped in
 * `<span class="md-meta">` and hidden by CSS until the caret enters the
 * inline element (which then gets `.md-expand`).
 *
 * Every inline wrapper carries data-s / data-e: its raw source range
 * relative to the start of the block text, so the editor can decide which
 * inline to expand for a given caret offset without measuring the DOM.
 */

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export const meta = (s: string) => (s ? `<span class="md-meta">${esc(s)}</span>` : "");

const unbracket = (u: string) => (u.startsWith("<") && u.endsWith(">") ? u.slice(1, -1) : u);
const SAFE_URL = /^(https?:|mailto:|#|\/|\.{0,2}\/|data:image\/|blob:|[^:]*$)/i;
const safeUrl = (u: string) => (SAFE_URL.test(u) ? esc(u) : "#");

interface Rule {
  re: RegExp;
  render(m: RegExpExecArray, at: number): string;
}

function wrap(tag: string, cls: string, at: number, len: number, inner: string, attrs = ""): string {
  return `<${tag} class="md-inline ${cls}" data-s="${at}" data-e="${at + len}"${attrs}>${inner}</${tag}>`;
}

const RULES: Rule[] = [
  {
    // backslash escape: keep the backslash as meta
    re: /\\([!-/:-@[-`{-~])/y,
    render: (m, at) => wrap("span", "md-escape", at, 2, meta("\\") + esc(m[1])),
  },
  {
    re: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y,
    render: (m, at) => wrap("code", "md-code", at, m[0].length, meta(m[1]) + esc(m[2]) + meta(m[1])),
  },
  {
    // inline math: source is hidden md-meta, the KaTeX render sits in a shadow root (no text)
    re: /\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/y,
    render: (m, at) =>
      wrap(
        "span",
        "md-math",
        at,
        m[0].length,
        meta("$") +
          `<span class="md-meta md-math-src">${esc(m[1])}</span>` +
          meta("$") +
          `<tm-math tex="${esc(m[1])}" contenteditable="false"></tm-math>`,
      ),
  },
  {
    // footnote reference [^id]
    re: /\[\^([^\]\s]+)\](?!:)/y,
    render: (m, at) =>
      wrap("sup", "md-fn-ref", at, m[0].length, meta("[^") + esc(m[1]) + meta("]"), ` data-fn="${esc(m[1])}"`),
  },
  {
    re: /!\[([^\]]*)\]\((<[^>\n]*>|[^)\s]*)(?:\s+"([^"\n]*)")?\)/y,
    render: (m, at) =>
      wrap(
        "span",
        "md-image",
        at,
        m[0].length,
        meta(m[0]) +
          `<img src="${safeUrl(unbracket(m[2]))}" alt="${esc(m[1])}"${m[3] ? ` title="${esc(m[3])}"` : ""} data-src="${esc(unbracket(m[2]))}" contenteditable="false" draggable="false">`,
      ),
  },
  {
    re: /\[([^\]]+)\]\((<[^>\n]*>|[^)\s]*)(?:\s+"[^"\n]*")?\)/y,
    render: (m, at) =>
      wrap(
        "a",
        "md-link",
        at,
        m[0].length,
        meta("[") + renderInline(m[1], at + 1) + meta(m[0].slice(1 + m[1].length)),
        ` href="${safeUrl(unbracket(m[2]))}"`,
      ),
  },
  {
    re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y,
    render: (m, at) =>
      wrap("strong", "md-strong", at, m[0].length, meta(m[1]) + renderInline(m[2], at + 2) + meta(m[1])),
  },
  {
    re: /~~(?=\S)([\s\S]*?\S)~~/y,
    render: (m, at) =>
      wrap("del", "md-del", at, m[0].length, meta("~~") + renderInline(m[1], at + 2) + meta("~~")),
  },
  {
    re: /==(?=\S)([\s\S]*?\S)==/y,
    render: (m, at) =>
      wrap("mark", "md-mark", at, m[0].length, meta("==") + renderInline(m[1], at + 2) + meta("==")),
  },
  {
    re: /(\*|_)(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_])/y,
    render: (m, at) =>
      wrap("em", "md-em", at, m[0].length, meta(m[1]) + renderInline(m[2], at + 1) + meta(m[1])),
  },
];

import { InlineExtension, registry } from "./extension";

const attrName = (k: string) => k.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/** Render an extension match; null when its parts don't add up to the match (invariant guard). */
function renderExt(ext: InlineExtension, m: RegExpExecArray, at: number): string | null {
  const parts = ext.parts?.(m) ?? [{ text: m[0] }];
  if (parts.map((p) => p.text).join("") !== m[0]) {
    console.warn(`[typemark] inline extension "${ext.name}": parts do not concatenate to the match; ignored`);
    return null;
  }
  let off = at;
  let inner = "";
  for (const p of parts) {
    inner += p.meta ? meta(p.text) : p.inline ? renderInline(p.text, off) : esc(p.text);
    off += p.text.length;
  }
  const data = ext.data?.(m) ?? {};
  const attrs =
    ` data-ext="${esc(ext.name)}"` +
    Object.entries(data)
      .map(([k, v]) => ` data-${attrName(k)}="${esc(String(v))}"`)
      .join("");
  return wrap("span", `md-x md-x-${attrName(ext.name)}`, at, m[0].length, inner, attrs);
}

/** Characters that may start an inline rule; everything else is plain text. */
const TRIGGER = /[\\`!\[*_~=$]/;

export function renderInline(src: string, base = 0): string {
  let out = "";
  let plain = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    let matched = false;
    for (const ext of registry.inline) {
      if (!src.startsWith(ext.trigger, i)) continue;
      ext.pattern.lastIndex = i;
      const m = ext.pattern.exec(src);
      if (!m || !m[0].length || (ext.accept && !ext.accept(m, src, i))) continue;
      const html = renderExt(ext, m, base + i);
      if (html === null) continue;
      out += esc(plain) + html;
      plain = "";
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched && TRIGGER.test(ch)) {
      // `_` only opens emphasis at a word boundary (snake_case stays plain)
      const intraword = ch === "_" && i > 0 && /\w/.test(src[i - 1]);
      for (const rule of RULES) {
        if (intraword && rule.re.source.includes("_")) continue;
        rule.re.lastIndex = i;
        const m = rule.re.exec(src);
        if (m) {
          out += esc(plain) + rule.render(m, base + i);
          plain = "";
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      plain += ch;
      i++;
    }
  }
  return out + esc(plain);
}
