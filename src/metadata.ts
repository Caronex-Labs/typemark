/**
 * Document metadata, computed from markdown alone (no DOM, no editor):
 * usable in the browser, a server, a worker or an indexer.
 *
 *   extractMetadata(md)    properties, outline, tasks, tags, mentions, links,
 *                          wikilinks, media, footnotes, instructions, stats
 *   buildBacklinks(docs)   who links to whom across a set of documents
 *
 * Offsets are positions in the markdown string (same as editor offsets).
 */
import { blockType, parse, readFrontmatter, separator } from "./block";

export interface Located {
  /** Markdown offset of the match. */
  offset: number;
  /** 1-based line number. */
  line: number;
}

export interface DocumentMetadata {
  frontmatter: { raw: string; data: Record<string, string | string[]> } | null;
  /** Front matter `title`, else the first heading, else null. */
  title: string | null;
  headings: (Located & { level: number; text: string })[];
  tasks: (Located & { text: string; done: boolean; depth: number; section: string | null })[];
  taskSummary: { total: number; done: number; open: number };
  /** Inline #tags plus front matter `tags`, with counts. */
  tags: { tag: string; count: number }[];
  mentions: { name: string; count: number }[];
  wikilinks: (Located & { target: string; alias: string | null })[];
  links: (Located & { url: string; text: string; external: boolean })[];
  images: (Located & { src: string; alt: string })[];
  embeds: (Located & { url: string; title: string })[];
  footnotes: { references: string[]; definitions: string[]; missing: string[]; unused: string[] };
  codeBlocks: (Located & { lang: string })[];
  diagrams: number;
  math: number;
  tables: number;
  callouts: (Located & { type: string })[];
  /** Pending `@ai` instructions. */
  instructions: (Located & { agent: string; instruction: string })[];
  stats: { words: number; characters: number; readingMinutes: number; blocks: number };
}

const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const MENTION = /(^|[\s(])@([\w.-]*\w)/g;
const WIKI = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
const LINK = /(!?)\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s]+)(?:\s+"[^"\n]*")?\)/g;
const EMBED = /^@\[([^\]]*)\]\((<[^>\n]*>|[^)\s]+)\)$/;
const FN_REF = /\[\^([^\]\s]+)\](?!:)/g;
const INSTR = /^@ai(?:\(([\w-]+)\))?:? /;

/** Blank out inline code and escaped chars so syntax inside them is not counted (keeps offsets). */
const maskCode = (s: string) => s.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length)).replace(/\\./g, "  ");
const unbracket = (u: string) => (u.startsWith("<") && u.endsWith(">") ? u.slice(1, -1) : u);
const plain = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`~=[\]>|]/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

export function extractMetadata(md: string): DocumentMetadata {
  const blocks = parse(md);
  const lineStarts = [0];
  for (let i = 0; i < md.length; i++) if (md[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const at = (offset: number): Located => ({ offset, line: lineOf(offset) });

  const meta: DocumentMetadata = {
    frontmatter: null,
    title: null,
    headings: [],
    tasks: [],
    taskSummary: { total: 0, done: 0, open: 0 },
    tags: [],
    mentions: [],
    wikilinks: [],
    links: [],
    images: [],
    embeds: [],
    footnotes: { references: [], definitions: [], missing: [], unused: [] },
    codeBlocks: [],
    diagrams: 0,
    math: 0,
    tables: 0,
    callouts: [],
    instructions: [],
    stats: { words: 0, characters: 0, readingMinutes: 0, blocks: blocks.length },
  };
  const tagCount = new Map<string, number>();
  const mentionCount = new Map<string, number>();
  const refs = new Set<string>();
  const defs = new Set<string>();
  let prose = "";
  let section: string | null = null;

  let pos = 0;
  blocks.forEach((b, i) => {
    if (i > 0) pos += separator(blocks[i - 1].src, b.src).length;
    const start = pos;
    pos += b.src.length;
    const t = blockType(b.src);

    if (t === "frontmatter") {
      const data = readFrontmatter(b.src);
      meta.frontmatter = { raw: b.src.split("\n").slice(1, -1).join("\n"), data };
      const tags = data.tags ?? data.tag;
      for (const tg of Array.isArray(tags) ? tags : tags ? String(tags).split(/[,\s]+/) : []) {
        const k = tg.replace(/^#/, "");
        if (k) tagCount.set(k, (tagCount.get(k) ?? 0) + 1);
      }
      return;
    }
    if (t === "code") {
      const lang = b.src.split("\n", 1)[0].replace(/^(`{3,}|~{3,})/, "").trim().split(/\s+/)[0] ?? "";
      meta.codeBlocks.push({ ...at(start), lang });
      if (lang.toLowerCase() === "mermaid") meta.diagrams++;
      return;
    }
    if (t === "math") return void meta.math++;
    if (t === "html" || t === "hr") return;
    if (t === "widget" || EMBED.test(b.src)) {
      const e = b.src.match(EMBED);
      if (e) meta.embeds.push({ ...at(start), url: unbracket(e[2]), title: e[1] });
      return;
    }
    if (t === "table") meta.tables++;
    if (t === "heading") {
      const level = b.src.match(/^#+/)![0].length;
      const text = plain(b.src.replace(/^#+\s+/, ""));
      meta.headings.push({ ...at(start), level, text });
      section = text;
    }
    const callout = b.src.match(/^> ?\[!(\w+)\]/);
    if (callout) meta.callouts.push({ ...at(start), type: callout[1].toLowerCase() });
    const instr = b.src.match(INSTR);
    if (instr) {
      meta.instructions.push({ ...at(start), agent: instr[1] ?? "ai", instruction: b.src.slice(instr[0].length).trim() });
      return; // an instruction is not document content yet
    }
    const task = b.src.match(/^(\s*)[-*+] \[([ xX])\] ?(.*)$/s);
    if (task) meta.tasks.push({ ...at(start), text: plain(task[3]), done: task[2] !== " ", depth: Math.floor(task[1].length / 2), section });
    const fdef = b.src.match(/^\[\^([^\]\s]+)\]:/);
    if (fdef) defs.add(fdef[1]);

    // inline scan (code spans masked so `#not-a-tag` stays out)
    const s = maskCode(b.src);
    for (const m of s.matchAll(WIKI)) meta.wikilinks.push({ ...at(start + m.index!), target: m[1].trim(), alias: m[2]?.trim() ?? null });
    const noWiki = s.replace(WIKI, (m) => " ".repeat(m.length));
    for (const m of noWiki.matchAll(LINK)) {
      const url = unbracket(m[3]);
      if (m[1]) meta.images.push({ ...at(start + m.index!), src: url, alt: m[2] });
      else if (!m[2].startsWith("^")) meta.links.push({ ...at(start + m.index!), url, text: m[2], external: /^[a-z][a-z0-9+.-]*:/i.test(url) });
    }
    const noLinks = noWiki.replace(LINK, (m) => " ".repeat(m.length)).replace(/https?:\/\/\S+/g, (m) => " ".repeat(m.length));
    for (const m of noLinks.matchAll(TAG)) if (!(t === "heading" && m.index === 0)) tagCount.set(m[2], (tagCount.get(m[2]) ?? 0) + 1);
    for (const m of noLinks.matchAll(MENTION)) if (!/^@\[/.test(noLinks.slice(m.index! + m[1].length))) mentionCount.set(m[2], (mentionCount.get(m[2]) ?? 0) + 1);
    for (const m of s.matchAll(FN_REF)) refs.add(m[1]);
    prose += " " + plain(b.src.slice(b.src.match(/^(#{1,6} |> ?(\[!\w+\] ?)?|\s*[-*+] (\[[ xX]\] )?|\s*\d+[.)] |\[\^[^\]]+\]: ?)/)?.[0].length ?? 0));
  });

  meta.title =
    (typeof meta.frontmatter?.data.title === "string" && meta.frontmatter.data.title) || meta.headings[0]?.text || null;
  meta.taskSummary = { total: meta.tasks.length, done: meta.tasks.filter((t) => t.done).length, open: meta.tasks.filter((t) => !t.done).length };
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  meta.tags = sorted(tagCount).map(([tag, count]) => ({ tag, count }));
  meta.mentions = sorted(mentionCount).map(([name, count]) => ({ name, count }));
  meta.footnotes = {
    references: [...refs],
    definitions: [...defs],
    missing: [...refs].filter((r) => !defs.has(r)),
    unused: [...defs].filter((d) => !refs.has(d)),
  };
  const words = (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  meta.stats = { words, characters: prose.replace(/\s+/g, "").length, readingMinutes: Math.max(1, Math.round(words / 230)), blocks: blocks.length };
  return meta;
}

// ------------------------------------------------------------------ backlinks

export interface Backlink {
  /** Id of the document that contains the link. */
  source: string;
  /** Link target as written. */
  target: string;
  kind: "wikilink" | "link";
  offset: number;
  line: number;
  /** The surrounding sentence, for display. */
  context: string;
}

/**
 * Backlinks across a set of documents: for each document id, the links that point AT it.
 * Targets resolve by document id, file name, front matter title or first heading
 * (case-insensitive), unless you pass `resolve`.
 */
export function buildBacklinks(
  docs: Record<string, string>,
  o: { resolve?(target: string, from: string): string | null } = {},
): { backlinks: Record<string, Backlink[]>; unresolved: Backlink[]; metadata: Record<string, DocumentMetadata> } {
  const metadata: Record<string, DocumentMetadata> = {};
  for (const [id, md] of Object.entries(docs)) metadata[id] = extractMetadata(md);
  const norm = (s: string) =>
    decodeURIComponent(s)
      .replace(/#.*$/, "")
      .replace(/^.*\//, "")
      .replace(/\.(md|markdown)$/i, "")
      .trim()
      .toLowerCase();
  const index = new Map<string, string>();
  for (const [id, m] of Object.entries(metadata)) {
    index.set(norm(id), id);
    if (m.title) index.set(m.title.toLowerCase(), id);
  }
  const resolve = o.resolve ?? ((t: string) => index.get(norm(t)) ?? index.get(t.trim().toLowerCase()) ?? null);
  const backlinks: Record<string, Backlink[]> = Object.fromEntries(Object.keys(docs).map((id) => [id, []]));
  const unresolved: Backlink[] = [];
  for (const [source, m] of Object.entries(metadata)) {
    const md = docs[source];
    const sentence = (off: number) => {
      const s = md.lastIndexOf("\n", off) + 1;
      const e = md.indexOf("\n", off);
      return plain(md.slice(s, e < 0 ? undefined : e)).slice(0, 240);
    };
    const add = (target: string, kind: Backlink["kind"], l: Located) => {
      const link: Backlink = { source, target, kind, offset: l.offset, line: l.line, context: sentence(l.offset) };
      const to = resolve(target, source);
      if (to && to !== source && backlinks[to]) backlinks[to].push(link);
      else if (!to) unresolved.push(link);
    };
    for (const w of m.wikilinks) add(w.target, "wikilink", w);
    for (const l of m.links) if (!l.external && !l.url.startsWith("#")) add(l.url, "link", l);
  }
  return { backlinks, unresolved, metadata };
}
