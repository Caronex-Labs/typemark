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

const SAFE_URL = /^(https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;
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
    re: /!\[([^\]]*)\]\(([^)\s]*)\)/y,
    render: (m, at) =>
      wrap(
        "span",
        "md-image",
        at,
        m[0].length,
        meta(m[0]) + `<img src="${safeUrl(m[2])}" alt="${esc(m[1])}" contenteditable="false">`,
      ),
  },
  {
    re: /\[([^\]]+)\]\(([^)\s]*)\)/y,
    render: (m, at) =>
      wrap(
        "a",
        "md-link",
        at,
        m[0].length,
        meta("[") + renderInline(m[1], at + 1) + meta(`](${m[2]})`),
        ` href="${safeUrl(m[2])}"`,
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

/** Characters that may start an inline rule; everything else is plain text. */
const TRIGGER = /[\\`!\[*_~=]/;

export function renderInline(src: string, base = 0): string {
  let out = "";
  let plain = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    let matched = false;
    if (TRIGGER.test(ch)) {
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
