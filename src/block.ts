/**
 * Block model. A document is an ordered list of blocks; each block owns its
 * raw markdown source. A block's type is DERIVED from its source every time
 * it renders, so typing "# " at the start of a paragraph turns it into a
 * heading with no special-case code.
 *
 * Invariant (same as inline): textContent(renderBlock(src)) === src.
 */
import { esc, meta, renderInline } from "./inline";

export type BlockType = "paragraph" | "heading" | "quote" | "ul" | "ol" | "task" | "code" | "hr";

export interface Block {
  id: string;
  src: string;
}

let seq = 0;
export const newId = () => `b${++seq}`;
export const mkBlock = (src: string): Block => ({ id: newId(), src });

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const RE = {
  heading: /^(#{1,6} )([\s\S]*)$/,
  quote: /^(> ?)([\s\S]*)$/,
  task: /^(\s*[-*+] \[[ xX]\] )([\s\S]*)$/,
  ul: /^(\s*[-*+] )([\s\S]*)$/,
  ol: /^(\s*\d{1,9}[.)] )([\s\S]*)$/,
  hr: /^(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/,
};

export function blockType(src: string): BlockType {
  if (FENCE_OPEN.test(src.split("\n", 1)[0])) return "code";
  if (RE.hr.test(src)) return "hr";
  if (RE.heading.test(src)) return "heading";
  if (RE.quote.test(src)) return "quote";
  if (RE.task.test(src)) return "task";
  if (RE.ul.test(src)) return "ul";
  if (RE.ol.test(src)) return "ol";
  return "paragraph";
}

/** Prefix that a new block created by Enter should inherit ("- ", "2. ", "> "). */
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
  const re = (RE as Record<string, RegExp>)[t];
  if (t === "heading" || t === "quote" || t === "task" || t === "ul" || t === "ol") return src.match(re)![1].length;
  return 0;
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
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      flush();
      const body = [line];
      const close = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++i < lines.length) {
        body.push(lines[i]);
        if (close.test(lines[i])) break;
      }
      out.push(mkBlock(body.join("\n")));
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

function codeHtml(src: string): string {
  const lines = src.split("\n");
  const open = lines[0];
  const fence = open.match(FENCE_OPEN)![1];
  const last = lines[lines.length - 1];
  const closed = lines.length > 1 && new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(last);
  const body = lines.slice(1, closed ? -1 : undefined).join("\n");
  const lang = esc(open.slice(fence.length).trim());
  return (
    `<pre class="md-block md-code-block"${lang ? ` data-lang="${lang}"` : ""}>` +
    `<span class="md-meta md-block-meta">${esc(open)}\n</span>` +
    `<code>${esc(body)}</code>` +
    (closed ? `<span class="md-meta md-block-meta">\n${esc(last)}</span>` : "") +
    `</pre>`
  );
}

/** Render one block's inner HTML + element tag + type. */
export function renderBlock(src: string): { tag: string; type: BlockType; html: string; attrs: string } {
  const type = blockType(src);
  const bm = (s: string) => (s ? `<span class="md-meta md-block-meta">${esc(s)}</span>` : "");
  const withPrefix = (re: RegExp) => {
    const m = src.match(re)!;
    return bm(m[1]) + renderInline(m[2], m[1].length);
  };
  switch (type) {
    case "code":
      return { tag: "div", type, html: codeHtml(src), attrs: "" };
    case "hr":
      return { tag: "div", type, html: bm(src), attrs: "" };
    case "heading": {
      const level = src.match(/^#+/)![0].length;
      return { tag: `h${level}`, type, html: withPrefix(RE.heading), attrs: "" };
    }
    case "quote":
      return { tag: "blockquote", type, html: withPrefix(RE.quote), attrs: "" };
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
  return Math.floor((src.match(/^ */)![0].length) / 2);
}
