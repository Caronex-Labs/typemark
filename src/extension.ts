/**
 * Extension API.
 *
 * Markdown stays the single source of truth. An extension only declares
 * SYNTAX (how source text maps to a block or inline element) and HOOKS
 * (what to draw in a widget, what happens on click). The engine keeps owning
 * parsing, editing, caret, undo and the textContent === source invariant;
 * the host app owns behaviour.
 *
 * Extensions are registered for the page (all editors), like custom elements.
 */
import type { Editor } from "./editor";

// ---------------------------------------------------------------- inline

/** One slice of an inline match. Slices must concatenate to the full match. */
export interface InlinePart {
  text: string;
  /** Syntax: hidden until the caret touches the element. */
  meta?: boolean;
  /** Render this slice through the normal inline renderer (bold inside an alias, ...). */
  inline?: boolean;
}

export interface InlineExtension {
  name: string;
  /** Literal start of the syntax ("[[", "#", "@", "::"). Cheap pre-check before `pattern`. */
  trigger: string;
  /** Matched at the trigger position (the engine adds the sticky flag). */
  pattern: RegExp;
  /** Split the match into visible / syntax parts. Default: whole match visible. */
  parts?(m: RegExpExecArray): InlinePart[];
  /** data-* attributes for the element (exposed to CSS, clicks and decorate). */
  data?(m: RegExpExecArray): Record<string, string>;
  /** Optional: reject a match by context (e.g. "#" must follow whitespace). */
  accept?(m: RegExpExecArray, src: string, at: number): boolean;
  /** Called on click (Cmd/Ctrl-click when `modClick` is true). */
  onClick?(data: Record<string, string>, ctx: { editor: Editor; event: MouseEvent; element: HTMLElement }): void;
  /** Require Cmd/Ctrl for onClick (default false; links use true so plain clicks still place the caret). */
  modClick?: boolean;
  /** Post-render DOM decoration that adds NO text (classes, titles, icons via CSS). */
  decorate?(element: HTMLElement, data: Record<string, string>, editor: Editor): void;
}

// ---------------------------------------------------------------- blocks

/** Context handed to a widget block when it mounts. */
export interface WidgetContext {
  /** Mount point (contenteditable=false): draw anything here. */
  el: HTMLElement;
  /** The block's full markdown source. */
  src: string;
  /** For fenced widgets: the text between the fences. For line widgets: the regex match. */
  body: string;
  match: RegExpExecArray | null;
  /** Replace this block's markdown (undoable). Use it to persist widget state (checkbox, counter, ...). */
  setSource(next: string): void;
  editor: Editor;
  blockId: string;
  readOnly: boolean;
}

interface BlockBase {
  name: string;
  /** data-* attributes for the block element (styling hooks). */
  data?(src: string): Record<string, string>;
}

/**
 * Text block with a syntax prefix (callouts "> [!note] ", toggles "+ ", ...).
 * The text after the prefix is normal, editable inline markdown.
 */
export interface PrefixBlockExtension extends BlockBase {
  kind: "prefix";
  /** Must match at the start of the block and capture the prefix as group 0. */
  prefix: RegExp;
  /** Prefix carried to the next block on Enter (null = plain paragraph). */
  continuation?(src: string): string | null;
}

/**
 * Atomic block whose UI the host draws. Source is hidden until the block
 * is focused (click the widget's padding / arrow into it to edit it).
 *  - fence:  ```lang ... ```   (e.g. ```button, ```query)
 *  - line:   one line matching `pattern` (e.g. [toc], ::bookmark[url])
 */
export interface WidgetBlockExtension extends BlockBase {
  kind: "widget";
  fence?: string;
  pattern?: RegExp;
  /** Draw the widget. Return a cleanup function if you attach listeners/timers outside `el`. */
  render(ctx: WidgetContext): void | (() => void);
  /** Re-render when ANY block changes (e.g. a table of contents). Default false. */
  live?: boolean;
}

export type BlockExtension = PrefixBlockExtension | WidgetBlockExtension;

// ---------------------------------------------------------------- suggestions

export interface SuggestItem {
  label: string;
  detail?: string;
  /** Short glyph / emoji shown before the label. */
  icon?: string;
  /** Extra words to match the query against. */
  keywords?: string;
  /**
   * What choosing the item does: a string replaces the trigger + query;
   * a function gets full control (the trigger + query are already removed).
   */
  apply: string | ((ctx: { editor: Editor }) => void);
}

export interface Suggester {
  name: string;
  /** Text immediately before the caret that opens the menu, e.g. "/", "[[", "@". */
  trigger: string;
  /** Only open at the start of a block or after whitespace (default true for 1-char triggers). */
  boundary?: boolean;
  /** Return items for the query typed after the trigger. */
  items(query: string, ctx: { editor: Editor }): SuggestItem[] | Promise<SuggestItem[]>;
}

export interface Extension {
  name: string;
  inline?: InlineExtension[];
  blocks?: BlockExtension[];
  suggesters?: Suggester[];
  /** Extra CSS injected once. */
  css?: string;
}

// ---------------------------------------------------------------- registry

export const registry = {
  inline: [] as InlineExtension[],
  blocks: [] as BlockExtension[],
  suggesters: [] as Suggester[],
  version: 0,
};

const installed = new Map<string, Extension>();

export function registerExtension(ext: Extension): () => void {
  if (installed.has(ext.name)) unregisterExtension(ext.name);
  installed.set(ext.name, ext);
  for (const i of ext.inline ?? []) {
    i.pattern = new RegExp(i.pattern.source, i.pattern.flags.replace("g", "").replace("y", "") + "y");
    registry.inline.push(i);
  }
  registry.blocks.push(...(ext.blocks ?? []));
  registry.suggesters.push(...(ext.suggesters ?? []));
  if (ext.css && typeof document !== "undefined") {
    const st = document.createElement("style");
    st.dataset.tmExtension = ext.name;
    st.textContent = ext.css;
    document.head.append(st);
  }
  registry.version++;
  return () => unregisterExtension(ext.name);
}

export function unregisterExtension(name: string): void {
  const ext = installed.get(name);
  if (!ext) return;
  installed.delete(name);
  const drop = <T>(arr: T[], items: T[] | undefined) => {
    for (const x of items ?? []) {
      const k = arr.indexOf(x);
      if (k >= 0) arr.splice(k, 1);
    }
  };
  drop(registry.inline, ext.inline);
  drop(registry.blocks, ext.blocks);
  drop(registry.suggesters, ext.suggesters);
  for (const st of document.querySelectorAll<HTMLStyleElement>("style[data-tm-extension]")) {
    if (st.dataset.tmExtension === name) st.remove();
  }
  registry.version++;
}

/** Find the extension block (if any) for a block source. */
export function matchBlockExt(src: string): { ext: BlockExtension; match: RegExpExecArray | null } | null {
  const first = src.split("\n", 1)[0];
  for (const ext of registry.blocks) {
    if (ext.kind === "prefix") {
      const m = ext.prefix.exec(src);
      if (m && m.index === 0) return { ext, match: m };
    } else if (ext.fence) {
      const f = first.match(/^(`{3,}|~{3,})\s*([\w-]+)/);
      if (f && f[2].toLowerCase() === ext.fence.toLowerCase()) return { ext, match: null };
    } else if (ext.pattern && src.indexOf("\n") < 0) {
      const re = new RegExp(`^(?:${ext.pattern.source})$`, ext.pattern.flags.replace(/[gy]/g, ""));
      const m = re.exec(src);
      if (m) return { ext, match: m };
    }
  }
  return null;
}
