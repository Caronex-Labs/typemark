/**
 * Clean paste: HTML (web pages, Google Docs, Word, Notion...) -> markdown.
 * Keeps structure (headings, lists, tasks, quotes, code, tables, links,
 * images, emphasis); drops styles, scripts, classes and layout noise.
 */

const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "figure", "figcaption", "li", "ul", "ol", "blockquote", "pre", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "dl", "dt", "dd"]);
const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "button", "svg", "canvas", "iframe", "object", "select", "textarea"]);

const escText = (s: string) => s.replace(/([\\`*_~[\]<>]|^#|^>|^\d+\.(?=\s)|^[-+](?=\s))/gm, "\\$1");

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Google Docs wraps everything in <b style="font-weight:normal">
  for (const b of doc.querySelectorAll<HTMLElement>('b[style*="font-weight:normal"], b[style*="font-weight: normal"]')) b.replaceWith(...b.childNodes);
  const out = blocks(doc.body, 0).replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function isBold(el: HTMLElement): boolean {
  const w = el.style?.fontWeight;
  return el.tagName === "B" || el.tagName === "STRONG" || w === "bold" || Number(w) >= 600;
}
function isItalic(el: HTMLElement): boolean {
  return el.tagName === "I" || el.tagName === "EM" || el.style?.fontStyle === "italic";
}
function isStrike(el: HTMLElement): boolean {
  return el.tagName === "S" || el.tagName === "DEL" || el.tagName === "STRIKE" || /line-through/.test(el.style?.textDecoration ?? "");
}

/** Inline content of a node as markdown (single paragraph). */
function inline(node: Node): string {
  let s = "";
  for (const n of Array.from(node.childNodes)) {
    if (n.nodeType === 3) {
      s += escText((n as Text).data.replace(/\s+/g, " "));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    if (tag === "br") {
      s += "\n";
      continue;
    }
    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      if (src && !src.startsWith("data:") && !src.startsWith("blob:")) s += `![${(el.getAttribute("alt") ?? "").replace(/[[\]]/g, "")}](${/[\s()]/.test(src) ? `<${src}>` : src})`;
      continue;
    }
    if (tag === "input" && (el as HTMLInputElement).type === "checkbox") continue; // handled by the list item
    if (tag === "code" || tag === "kbd" || tag === "samp" || el.style?.fontFamily?.match(/mono|courier|consolas/i)) {
      const t = el.textContent ?? "";
      if (!t) continue;
      const ticks = "`".repeat((t.match(/`+/g) ?? []).reduce((m, x) => Math.max(m, x.length + 1), 1));
      s += `${ticks}${ticks.length > 1 || t.startsWith("`") ? " " : ""}${t}${ticks.length > 1 ? " " : ""}${ticks}`;
      continue;
    }
    let inner = BLOCK.has(tag) ? " " + inline(el) + " " : inline(el);
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      const text = inner.trim();
      if (href && !href.startsWith("javascript:")) inner = text && (el.textContent ?? "").trim() !== href ? `[${text}](${/[\s()]/.test(href) ? `<${href}>` : href})` : `<${href}>`;
      s += inner;
      continue;
    }
    if (tag === "sup" && /^\[?\d+\]?$/.test(inner.trim())) {
      s += `[^${inner.trim().replace(/\D/g, "")}]`;
      continue;
    }
    if (tag === "mark") inner = wrap(inner, "==");
    if (isStrike(el)) inner = wrap(inner, "~~");
    if (isItalic(el)) inner = wrap(inner, "*");
    if (isBold(el)) inner = wrap(inner, "**");
    s += inner;
  }
  return s;
}

/** Wrap keeping surrounding whitespace outside the markers ("** a **" is not bold). */
function wrap(s: string, mark: string): string {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
}

function blocks(node: Node, depth: number): string {
  let out = "";
  let para = "";
  const flush = () => {
    const p = para.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/ {2,}/g, " ").trim();
    if (p) out += p + "\n\n";
    para = "";
  };
  for (const n of Array.from(node.childNodes)) {
    if (n.nodeType === 3) {
      para += escText((n as Text).data.replace(/\s+/g, " "));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    if (!BLOCK.has(tag)) {
      para += inline({ childNodes: [el] } as unknown as Node);
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(tag)) out += `${"#".repeat(Number(tag[1]))} ${inline(el).replace(/\n/g, " ").trim()}\n\n`;
    else if (tag === "hr") out += "---\n\n";
    else if (tag === "pre") {
      const code = el.querySelector("code") ?? el;
      const lang = (code.className.match(/(?:language|lang)-([\w-]+)/) ?? [])[1] ?? "";
      const text = (code.textContent ?? "").replace(/\n$/, "");
      const fence = "`".repeat(Math.max(3, ...(text.match(/`{3,}/g) ?? []).map((x) => x.length + 1)));
      out += `${fence}${lang}\n${text}\n${fence}\n\n`;
    } else if (tag === "blockquote") {
      const inner = blocks(el, depth).trim();
      out += inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + "\n\n";
    } else if (tag === "ul" || tag === "ol") out += list(el, depth) + "\n";
    else if (tag === "table") out += table(el) + "\n\n";
    else out += blocks(el, depth);
  }
  flush();
  return out;
}

function list(el: HTMLElement, depth: number): string {
  const ordered = el.tagName === "OL";
  let n = Number(el.getAttribute("start") ?? 1);
  let out = "";
  for (const li of Array.from(el.children)) {
    if (li.tagName !== "LI") continue;
    const box = li.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
    const marker = ordered ? `${n++}. ` : "- ";
    const task = box ? `[${box.checked || box.hasAttribute("checked") ? "x" : " "}] ` : "";
    const nested = Array.from(li.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
    const clone = li.cloneNode(true) as HTMLElement;
    for (const c of Array.from(clone.children)) if (c.tagName === "UL" || c.tagName === "OL") c.remove();
    const text = blocks(clone, depth + 1).trim().replace(/\n\n+/g, "\n").replace(/\n/g, " ");
    out += `${"  ".repeat(depth)}${marker}${task}${text}\n`;
    for (const c of nested) out += list(c as HTMLElement, depth + 1);
  }
  return out;
}

function table(el: HTMLElement): string {
  const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children).map((c) => inline(c).replace(/\n/g, " ").replace(/\|/g, "\\|").trim()),
  );
  if (!rows.length) return "";
  const w = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(w)}`, ...rows.slice(1).map(line)].join("\n");
}
