/**
 * Block model. A document is an ordered list of blocks; each block owns its
 * raw markdown source. A block's type is DERIVED from its source every time
 * it renders, so typing "# " at the start of a paragraph turns it into a
 * heading with no special-case code.
 *
 * Invariant (same as inline): textContent(renderBlock(src)) === src.
 */
import hljs from "highlight.js/lib/common";
import { esc, meta, renderInline } from "./inline";

export type BlockType =
  | "paragraph"
  | "heading"
  | "quote"
  | "ul"
  | "ol"
  | "task"
  | "code"
  | "math"
  | "table"
  | "footnote"
  | "hr";

export interface Block {
  id: string;
  src: string;
}

let seq = 0;
export const newId = () => `b${++seq}`;
export const mkBlock = (src: string): Block => ({ id: newId(), src });

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const MATH_OPEN = /^\$\$\s*$/;
const TABLE_SEP = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const RE = {
  heading: /^(#{1,6} )([\s\S]*)$/,
  quote: /^((?:> ?)+)([\s\S]*)$/,
  footnote: /^(\[\^[^\]\s]+\]: ?)([\s\S]*)$/,
  task: /^(\s*[-*+] \[[ xX]\] )([\s\S]*)$/,
  ul: /^(\s*[-*+] )([\s\S]*)$/,
  ol: /^(\s*\d{1,9}[.)] )([\s\S]*)$/,
  hr: /^(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/,
};
const PREFIXED = ["heading", "quote", "footnote", "task", "ul", "ol"] as const;

export function blockType(src: string): BlockType {
  const first = src.split("\n", 1)[0];
  if (FENCE_OPEN.test(first)) return "code";
  if (MATH_OPEN.test(first)) return "math";
  if (first.startsWith("|") && src.includes("\n") && TABLE_SEP.test(src.split("\n")[1])) return "table";
  if (RE.hr.test(src)) return "hr";
  for (const t of PREFIXED) if (RE[t].test(src)) return t;
  return "paragraph";
}

/** Prefix that a new block created by Enter should inherit ("- ", "2. ", "> > "). */
export function continuation(src: string): string | null {
  const t = blockType(src);
  if (t === "task") return src.match(/^(\s*[-*+] )/)![1] + "[ ] ";
  if (t === "ul") return src.match(RE.ul)![1];
  if (t === "quote") return src.match(RE.quote)![1];
  if (t === "ol") {
    const m = src.match(/^(\s*)(\d+)([.)] )/)!;
    return `${m[1]}${Number(m[2]) + 1}${m[3]}`;
  }
  return null;
}

/** Length of the block-level syntax prefix (where the "content" starts). */
export function prefixLen(src: string): number {
  const t = blockType(src);
  return (PREFIXED as readonly string[]).includes(t) ? src.match(RE[t as (typeof PREFIXED)[number]])![1].length : 0;
}

/** For fenced blocks (code / math): the opening line and whether it is closed. */
export function fenceInfo(src: string): { open: string; closer: string; closed: boolean } | null {
  const lines = src.split("\n");
  const first = lines[0];
  let closer: string;
  let closeRe: RegExp;
  const f = first.match(FENCE_OPEN);
  if (f) {
    closer = f[1];
    closeRe = new RegExp(`^${f[1][0] === "`" ? "`" : "~"}{${f[1].length},}\\s*$`);
  } else if (MATH_OPEN.test(first)) {
    closer = "$$";
    closeRe = /^\$\$\s*$/;
  } else return null;
  return { open: first, closer, closed: lines.length > 1 && closeRe.test(lines[lines.length - 1]) };
}

/** Markdown text -> blocks. Lists/quotes are one block per line; paragraphs keep soft line breaks. */
export function parse(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(mkBlock(para.join("\n")));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = fenceInfo(line);
    if (fence) {
      flush();
      const body = [line];
      while (++i < lines.length) {
        body.push(lines[i]);
        if (fenceInfo(body.join("\n"))!.closed) break;
      }
      out.push(mkBlock(body.join("\n")));
      continue;
    }
    if (line.startsWith("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const rows = [line, lines[++i]];
      while (i + 1 < lines.length && lines[i + 1].startsWith("|")) rows.push(lines[++i]);
      out.push(mkBlock(rows.join("\n")));
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const t = blockType(line);
    if (t !== "paragraph") {
      flush();
      out.push(mkBlock(line));
    } else para.push(line);
  }
  flush();
  return out.length ? out : [mkBlock("")];
}

const tight = (t: BlockType) => t === "ul" || t === "ol" || t === "task" || t === "quote";

/** Blocks -> markdown. Adjacent list items / quote lines stay tight. */
export function serialize(blocks: Block[]): string {
  let md = "";
  blocks.forEach((b, i) => {
    if (i > 0) {
      const a = blockType(blocks[i - 1].src);
      const t = blockType(b.src);
      md += tight(a) && a === t ? "\n" : "\n\n";
    }
    md += b.src;
  });
  return md;
}

const bm = (s: string, extra = "") => (s ? `<span class="md-meta md-block-meta${extra}">${esc(s)}</span>` : "");

function highlight(body: string, lang: string): string {
  const l = lang.toLowerCase();
  if (l && hljs.getLanguage(l)) {
    try {
      return hljs.highlight(body, { language: l, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return esc(body);
}

function fencedHtml(src: string, kind: "code" | "math"): string {
  const info = fenceInfo(src)!;
  const lines = src.split("\n");
  const body = lines.slice(1, info.closed ? -1 : undefined).join("\n");
  const close = info.closed ? `<span class="md-meta md-block-meta">\n${esc(lines[lines.length - 1])}</span>` : "";
  const open = `<span class="md-meta md-block-meta">${esc(info.open)}${lines.length > 1 ? "\n" : ""}</span>`;
  if (kind === "math") {
    return (
      `<div class="md-math-block-src">${open}<span class="md-meta md-block-meta md-math-body">${esc(body)}</span>${close}</div>` +
      `<tm-math display tex="${esc(body)}" contenteditable="false"></tm-math>`
    );
  }
  const lang = info.open.slice(info.closer.length).trim();
  return (
    `<pre class="md-code-block"${lang ? ` data-lang="${esc(lang)}"` : ""}>` +
    open +
    `<code class="hljs">${highlight(body, lang)}</code>` +
    close +
    `</pre>`
  );
}

/** Split a table row at unescaped pipes; returns pipe indices. */
function pipesOf(line: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "`") {
      // a closed code span protects its pipes: | `a | b` | is one cell
      const ticks = line.slice(i).match(/^`+/)![0];
      const close = line.indexOf(ticks, i + ticks.length);
      if (close > 0) i = close + ticks.length - 1;
      else i += ticks.length - 1;
    } else if (line[i] === "|") out.push(i);
  }
  return out;
}

export function tableCellStarts(line: string): number[] {
  return pipesOf(line).map((p) => p + 1);
}

function tableHtml(src: string): string {
  const lines = src.split("\n");
  const aligns = pipesOf(lines[1]).slice(0, -1).map((p, k, arr) => {
    const next = pipesOf(lines[1])[k + 1];
    const cell = lines[1].slice(p + 1, next).trim();
    return cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "";
  });
  const pipe = (s: string) => (s ? `<span class="md-meta md-pipe">${esc(s)}</span>` : "");
  let base = 0;
  const rows = lines.map((line, r) => {
    const nl = r < lines.length - 1 ? "\n" : "";
    const ps = pipesOf(line);
    const sep = r === 1;
    const tag = r === 0 ? "th" : "td";
    let cells = "";
    if (ps.length < 2) {
      // malformed row while typing: one cell holding the raw line
      cells = `<${tag}>${sep ? pipe(line + nl) : esc(line) + pipe(nl)}</${tag}>`;
    } else {
      for (let k = 0; k < ps.length - 1; k++) {
        const raw = line.slice(ps[k] + 1, ps[k + 1]);
        const lead = k === 0 ? pipe(line.slice(0, ps[0] + 1)) : "";
        const trail = k === ps.length - 2 ? pipe(line.slice(ps[k + 1]) + nl) : pipe("|");
        const body = sep ? pipe(raw) : renderInline(raw, base + ps[k] + 1);
        const al = aligns[k] ? ` style="text-align:${aligns[k]}"` : "";
        cells += `<${tag}${al}>${lead}${body}${trail}</${tag}>`;
      }
    }
    base += line.length + 1;
    return `<tr${sep ? ' class="md-table-sep"' : ""}>${cells}</tr>`;
  });
  return `<table><thead>${rows.slice(0, 2).join("")}</thead><tbody>${rows.slice(2).join("")}</tbody></table>`;
}

/** Render one block's inner HTML + element tag + type. */
export function renderBlock(src: string): { tag: string; type: BlockType; html: string; attrs: string } {
  const type = blockType(src);
  const withPrefix = (re: RegExp) => {
    const m = src.match(re)!;
    return bm(m[1]) + renderInline(m[2], m[1].length);
  };
  switch (type) {
    case "code":
      return { tag: "div", type, html: fencedHtml(src, "code"), attrs: "" };
    case "math":
      return { tag: "div", type, html: fencedHtml(src, "math"), attrs: "" };
    case "table":
      return { tag: "div", type, html: tableHtml(src), attrs: "" };
    case "hr":
      return { tag: "div", type, html: bm(src), attrs: "" };
    case "heading": {
      const level = src.match(/^#+/)![0].length;
      return { tag: `h${level}`, type, html: withPrefix(RE.heading), attrs: "" };
    }
    case "quote": {
      const depth = (src.match(RE.quote)![1].match(/>/g) || []).length;
      return { tag: "blockquote", type, html: withPrefix(RE.quote), attrs: ` style="--depth:${depth}" data-depth="${depth}"` };
    }
    case "footnote": {
      const label = src.match(/^\[\^([^\]]+)\]/)![1];
      return { tag: "div", type, html: withPrefix(RE.footnote), attrs: ` data-fn="${esc(label)}" id="fn-${esc(label)}"` };
    }
    case "task": {
      const checked = /\[[xX]\]/.test(src.match(RE.task)![1]);
      return { tag: "div", type, html: withPrefix(RE.task), attrs: checked ? ` data-checked="true"` : "" };
    }
    case "ol": {
      const n = src.match(/\d+/)![0];
      return { tag: "div", type, html: withPrefix(RE.ol), attrs: ` data-n="${n}"` };
    }
    case "ul":
      return { tag: "div", type, html: withPrefix(RE.ul), attrs: "" };
    default:
      return { tag: "p", type, html: renderInline(src) || "", attrs: "" };
  }
}

export function indentOf(src: string): number {
  return Math.floor(src.match(/^ */)![0].length / 2);
}

export { pipesOf };
