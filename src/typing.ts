/**
 * Typing aids: wrap a selection with a typed mark, auto-close brackets,
 * type over auto-inserted closers, delete empty pairs, smart punctuation —
 * plus the clean-paste decision (HTML -> markdown, URL over a selection -> link).
 *
 * The editor hands each beforeinput / paste to this module with a tiny view of
 * the caret block; everything here works on raw markdown offsets.
 */
import { blockType } from "./block";
import { htmlToMarkdown } from "./paste";

export interface TypingAidOptions {
  /** Typing * _ ` ~ = [ ( " over a selection wraps it. */
  wrap?: boolean;
  /** Auto-close ( [ { and backtick; type over / backspace the closer. */
  pairs?: boolean;
  /** ` -- ` -> ` — `, `...` -> `…`. */
  smartPunctuation?: boolean;
}

/** The caret block, as the editor exposes it to the aids. */
export interface TypingCtx {
  bid: string;
  src: string;
  /** Selection in raw block offsets, start <= end. */
  start: number;
  end: number;
  /** Replace the block source and select [a, b] (caret at a when b is omitted). */
  set(src: string, a: number, b?: number, kind?: string): void;
}

const WRAP: Record<string, string> = { "*": "*", _: "_", "`": "`", "~": "~", "=": "=", "[": "]", "(": ")", '"': '"' };
const PAIR: Record<string, string> = { "(": ")", "[": "]", "{": "}", "`": "`" };
const CLOSERS = new Set([")", "]", "}", "`"]);
const EXEMPT = new Set(["code", "math", "frontmatter", "html"]);

/** Is offset `off` inside an inline code span on its line? */
function inCodeSpan(src: string, off: number): boolean {
  const line = src.slice(src.lastIndexOf("\n", off - 1) + 1, off);
  return ((line.match(/`/g) ?? []).length & 1) === 1;
}

export class TypingAids {
  private o: Required<TypingAidOptions>;
  /** Auto-inserted closers, as (block, distance from block end) — stable while typing before them. */
  private closers: { bid: string; fromEnd: number; ch: string }[] = [];
  private plainPaste = false;

  constructor(opt: boolean | TypingAidOptions | undefined) {
    const on = opt !== false;
    const o = typeof opt === "object" ? opt : {};
    this.o = { wrap: on && o.wrap !== false, pairs: on && o.pairs !== false, smartPunctuation: on && o.smartPunctuation !== false };
  }

  /** Track Cmd/Ctrl+Shift+V (paste as plain text). */
  noteKey(e: KeyboardEvent): void {
    if (e.key.toLowerCase() === "v" && (e.metaKey || e.ctrlKey)) this.plainPaste = e.shiftKey;
  }

  private closerAt(c: TypingCtx, off: number): number {
    return this.closers.findIndex((k) => k.bid === c.bid && c.src.length - k.fromEnd === off && c.src[off] === k.ch);
  }

  /** Handle one beforeinput; returns true when it changed the model (event already prevented). */
  handleInput(c: TypingCtx, e: InputEvent): boolean {
    if (EXEMPT.has(blockType(c.src))) return false;
    const t = e.inputType;
    const { src, start, end } = c;
    this.closers = this.closers.filter((k) => k.fromEnd <= src.length);
    const done = (s: string, a: number, b?: number, kind = "type") => {
      e.preventDefault();
      c.set(s, a, b, kind);
      return true;
    };

    if (t === "deleteContentBackward" && start === end && this.o.pairs && start > 0) {
      const i = this.closerAt(c, start);
      if (i >= 0 && PAIR[src[start - 1]] === src[start]) {
        this.closers.splice(i, 1);
        return done(src.slice(0, start - 1) + src.slice(start + 1), start - 1);
      }
      return false;
    }
    if (t !== "insertText" || !e.data || e.data.length !== 1) return false;
    const ch = e.data;

    if (start !== end) {
      if (!this.o.wrap || !(ch in WRAP) || src.slice(start, end).includes("\n")) return false;
      if (inCodeSpan(src, start) && ch !== "`") return false;
      return done(src.slice(0, start) + ch + src.slice(start, end) + WRAP[ch] + src.slice(end), start + 1, end + 1, "edit");
    }
    const off = start;
    if (inCodeSpan(src, off) && ch !== "`") return false;

    if (this.o.pairs) {
      if (CLOSERS.has(ch)) {
        const i = this.closerAt(c, off);
        if (i >= 0 && src[off] === ch) {
          this.closers.splice(i, 1);
          return done(src, off + 1);
        }
      }
      const next = src[off] ?? "";
      const prev = src[off - 1] ?? "";
      // a backtick right after a backtick is a fence / longer span being typed: leave it alone
      if (ch in PAIR && !(ch === "`" && prev === "`") && (next === "" || /[\s)\]}.,;:!?]/.test(next))) {
        const s = src.slice(0, off) + ch + PAIR[ch] + src.slice(off);
        this.closers.push({ bid: c.bid, fromEnd: s.length - (off + 1), ch: PAIR[ch] });
        return done(s, off + 1);
      }
    }

    if (this.o.smartPunctuation && !inCodeSpan(src, off)) {
      if (ch === " " && off >= 3 && src.slice(off - 3, off) === " --" && src[off - 4] !== "-")
        return done(src.slice(0, off - 2) + "— " + src.slice(off), off);
      if (ch === "." && off >= 3 && src.slice(off - 2, off) === ".." && src[off - 3] !== "." && !/\n$/.test(src.slice(0, off - 2)))
        return done(src.slice(0, off - 2) + "…" + src.slice(off), off - 1);
    }
    return false;
  }

  /**
   * Decide a paste. Returns the markdown to insert over the selection, or null
   * to leave it to the editor's default (image files, plain text via beforeinput).
   */
  pasteText(c: TypingCtx | null, data: DataTransfer | null): string | null {
    const plainOnly = this.plainPaste;
    this.plainPaste = false;
    if (!data) return null;
    if (c && EXEMPT.has(blockType(c.src))) return null;
    const text = data.getData("text/plain") ?? "";
    if (c && c.start !== c.end && /^https?:\/\/\S+$/.test(text.trim())) {
      const sel = c.src.slice(c.start, c.end);
      if (!sel.includes("\n") && !inCodeSpan(c.src, c.start)) return `[${sel}](${text.trim()})`;
    }
    const html = data.getData("text/html");
    if (plainOnly || !html) return null;
    const md = htmlToMarkdown(html);
    return md || null;
  }
}
