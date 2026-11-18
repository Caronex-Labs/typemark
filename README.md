# typemark-lite

A small, framework-free markdown editing engine with Typora-style **seamless live preview**: you see a rendered document,
and markdown syntax appears only around the caret. The source of truth is always plain markdown.

- ~56 KB JS + 8 KB CSS (plus `katex` and `highlight.js`, which your app dedupes)
- Works in any framework (React, Svelte, Vue, plain DOM) — it just takes an element
- Headings, emphasis, links, images, lists, task lists, quotes (nested), code blocks with highlighting,
  tables, inline and block math (KaTeX), footnotes, horizontal rules, strike, highlight
- Images (URL, upload, paste, drop), embeds, Mermaid diagrams, callouts, table of contents, front matter
  properties: **all through markdown syntax**, no buttons needed
- **Source mode** shows the same page with every markdown character visible, still editable
- An **extension API** for your own blocks, inline syntax, widgets, buttons and autocomplete: the engine owns
  editing, your app owns behaviour

## Install

Not published to npm. Use it from a local path or git:

```bash
npm install ../typemark-lite                 # local path (run `npm run build` in typemark-lite first)
npm install ./typemark-lite-0.2.0.tgz        # tarball from `npm run pack:local`
npm install git+ssh://<your-remote>/typemark-lite.git
```

## Use

```ts
import { createEditor } from "typemark-lite";
import "typemark-lite/style.css";

const editor = createEditor(document.querySelector("#editor")!, {
  value: "# Hello\n\nStart *writing*.",
  placeholder: "Start writing…",
  onChange: (markdown) => save(markdown),
  onStateChange: (state) => updateToolbar(state),
});

editor.getMarkdown();          // current document
editor.setMarkdown("# New");   // replace (clears undo history)
editor.exec({ type: "bold" }); // toolbar command
editor.destroy();              // remove listeners, keep rendered content
```

Your bundler must handle CSS imports (Vite, webpack with css-loader, esbuild, Parcel all do). The engine imports
`katex/dist/katex.min.css` itself so KaTeX's fonts get resolved by your bundler.

### React

```tsx
function MarkdownEditor({ value, onChange }: { value: string; onChange(md: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const ed = createEditor(ref.current!, { value, onChange: (md) => cb.current(md) });
    return () => ed.destroy();
  }, []); // the editor owns the document after mount; call ed.setMarkdown to replace it
  return <div ref={ref} />;
}
```

## API

### `createEditor(element, options?) → Editor`

| option          | type                           | default |                                                        |
|-----------------|--------------------------------|---------|--------------------------------------------------------|
| `value`         | `string`                       | `""`    | initial markdown                                       |
| `onChange`      | `(markdown: string) => void`   |         | after every edit                                       |
| `onStateChange` | `(state: EditorState) => void` |         | caret moved or doc changed (deduplicated)              |
| `placeholder`   | `string`                       |         | shown while empty                                      |
| `readOnly`      | `boolean`                      | `false` | render only                                            |
| `spellcheck`    | `boolean`                      | `true`  |                                                        |
| `uploadImage`   | `(file) => Promise<url>`       | data URL | store pasted / dropped / picked images                |
| `resolveImageUrl` | `(src) => url`               |         | map markdown srcs (e.g. relative paths) to loadable URLs |
| `embedPolicy`   | `(url: URL) => boolean`        | https, cross-origin | which embeds may load                      |
| `renderers`     | `Record<lang, FenceRenderer>`  |         | e.g. `{ mermaid: mermaidRenderer(() => import("mermaid")) }` |
| `coreExtensions`| `boolean`                      | `true`  | register embeds, `[toc]`, callouts, `/` menu           |

### `Editor`

| method                    |                                                             |
|---------------------------|-------------------------------------------------------------|
| `getMarkdown()`           | the document as markdown                                    |
| `setMarkdown(md)`         | replace the document; clears undo history                   |
| `exec(command)`           | run a command at the caret (see below)                      |
| `getState()`              | `EditorState` at the caret                                  |
| `setReadOnly(b)` / `isReadOnly()` |                                                     |
| `focus()`                 | caret to end of document                                    |
| `setSourceMode(b)` / `isSourceMode()` | show every markdown character in place (still editable) |
| `setFocusMode(b)`         | fade all blocks but the current one                         |
| `getStats()`              | `{ words, characters, readingMinutes }`                     |
| `getBlocks()` / `updateBlock(id, src)` | read / replace blocks (undoable)               |
| `getHeadings()` / `revealBlock(id)` | outline and navigation                            |
| `getFrontmatter()` / `setFrontmatter(yaml \| null)` | document properties                  |
| `insertImages(files, at?)` / `pickImage()` | upload through `uploadImage`               |
| `refresh()`               | re-render after registering extensions on a live editor     |
| `undo()` / `redo()`       |                                                             |
| `destroy()`               | remove all listeners; rendered content stays                |
| `root`                    | the element                                                 |

### Commands

```ts
type Command =
  | { type: "bold" | "italic" | "code" | "strike" | "highlight" } // wrap/unwrap selection
  | { type: "heading"; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 }        // 0 = paragraph
  | { type: "bulletList" | "orderedList" | "taskList" | "quote" } // same command again toggles off
  | { type: "codeBlock" | "mathBlock" | "table" | "hr" }          // insert
  | { type: "image"; src: string; alt?: string } | { type: "imagePicker" }
  | { type: "embed"; url: string }                                // inserts @[](url)
  | { type: "diagram"; lang?: string }                            // fenced block for a renderer
  | { type: "insertText"; text: string; caret?: number }
  | { type: "insertBlock"; src: string; caret?: number }
  | { type: "undo" | "redo" };
```

Commands exist for apps that need them (menus, shortcuts, AI insertions); writers never need a toolbar.

### `EditorState`

```ts
{ block: BlockType | null; headingLevel: number; formats: InlineFormat[]; canUndo: boolean; canRedo: boolean }
```

### Lower-level exports

`parse(md) → Block[]`, `serialize(blocks) → md`, `renderBlock(src)`, `renderInline(src)`, `blockType(src)` —
useful for rendering markdown read-only with exactly the editor's look (wrap output in an element with class
`tm-editor`).

## Syntax

Everything is typed. Syntax this engine invented is marked ★.

| You type | You get |
|---|---|
| `# `, `## ` … | headings |
| `- `, `1. `, `- [ ] ` | lists and tasks (Enter continues, Tab indents) |
| `> `, `> > ` | quotes, nested |
| `> [!note] ` / `tip` `info` `success` `warning` `danger` `bug` `example` `quote` `todo` | callouts (Obsidian syntax) |
| `**b**` `*i*` `` `c` `` `~~s~~` `==h==` `[t](url)` | inline formatting |
| `![alt](url)` | image; ★ press **Enter** inside an empty `![]()` to pick a file; paste/drop an image to upload |
| ★ `@[title](url)` | embed: YouTube, Vimeo, Loom, CodePen, Figma, audio/video files, any https page (sandboxed) |
| `<iframe …>`, `<video …>` | raw embeds (attribute-whitelisted) |
| ```` ```lang ```` + Enter | code block (highlighted); ```` ```mermaid ```` renders a diagram |
| `$x$`, `$$` + Enter | math (KaTeX) |
| `\| a \| b \|` + Enter | table (Tab moves between cells) |
| ★ `[toc]` | live table of contents |
| `[^1]` / `[^1]: text` | footnotes |
| `---` at the top … `---` | front matter, shown as a properties panel |
| `/` at line start | menu that **types the syntax for you** |

## Keyboard

| keys                       |                                                       |
|----------------------------|-------------------------------------------------------|
| Cmd/Ctrl + B / I / E       | bold / italic / inline code                           |
| Cmd/Ctrl + Z, Shift+Cmd+Z  | undo / redo                                           |
| Enter                      | new block; continues lists and quotes; ends an empty item |
| Shift + Enter              | soft line break                                       |
| Tab / Shift + Tab          | indent list item · next/previous table cell           |
| `| a | b |` + Enter        | create a table                                        |
| ```` ```lang ```` / `$$` + Enter | open a code / math block                        |
| Cmd/Ctrl + click           | follow link · jump to footnote                        |

Copy produces markdown, paste takes plain text (multi-line paste becomes blocks).

## Extensions

Extensions declare **syntax** and **hooks**; markdown stays the only source of truth. Register them for the page with
`registerExtension(ext)` (returns an unregister function).

```ts
import { registerExtension, wikilinks, tags, mentions, actionButtons } from "typemark-lite";

registerExtension(wikilinks({ onOpen: (t) => router.open(t), exists: (t) => db.has(t), suggest: (q) => db.search(q) }));
registerExtension(tags({ onOpen: (t) => search("#" + t) }));
registerExtension(mentions({ onOpen: (u) => profile(u), suggest: (q) => users(q) }));
registerExtension(actionButtons({ onAction: ({ action, args }, { editor }) => run(action, args) }));
```

```button
label: Deploy preview
action: deploy
env: staging
```

Four extension points:

| Kind | Use for | You provide |
|---|---|---|
| **inline** | `[[links]]`, `#tags`, `@mentions`, dates, emoji | `trigger`, `pattern`, `parts` (which slices are syntax), `data`, `onClick`, `decorate` |
| **prefix block** | callouts, toggles, custom headings | `prefix` regex, `data`, `continuation` |
| **widget block** | buttons, link cards, queries, databases, charts, TOC | ```` ```fence ```` or one-line `pattern`, `render(ctx)` that draws into `ctx.el`, `ctx.setSource()` to persist state, optional `live` |
| **suggester** | `/` menu, `[[` / `@` / `#` autocomplete | `trigger`, `items(query)` → `{ label, detail, icon, apply }` |

A widget example: a counter whose state lives in the markdown.

```ts
registerExtension({
  name: "counter",
  blocks: [{
    kind: "widget", name: "counter", pattern: /\{\{count:(\d+)\}\}/,
    render({ el, match, setSource }) {
      const b = document.createElement("button");
      b.textContent = `clicked ${match![1]}`;
      b.onclick = () => setSource(`{{count:${+match![1] + 1}}}`); // undoable, saved in the document
      el.append(b);
    },
  }],
});
```

Rules the engine enforces: inline `parts` must add up to the matched text (otherwise the extension is ignored), and
anything you draw goes in `[data-tm-ui]` mounts, which never count as document text.

## Theming

Everything lives under `.tm-editor`. Override the custom properties (light and dark are built in):

```css
.tm-editor {
  --tm-fg: #333; --tm-bg: #fff; --tm-meta: #b4b4b4; --tm-accent: #4183c4;
  --tm-code-bg: #f3f4f4; --tm-quote: #777; --tm-border: #dfe2e5;
  max-width: 860px; padding: 40px 30px 40vh; /* page layout: override freely */
}
```

## How it works

The model is a list of blocks, each holding its raw markdown. Rendering keeps **every markdown character in the DOM**:
syntax is wrapped in `<span class="md-meta">` and hidden by CSS, so `block.textContent === block markdown` always.
That invariant is what makes the editor feel seamless:

1. Plain typing is left to the browser (fast; IME and autocorrect work).
2. On `input`, the caret block's `textContent` *is* its new source; it is re-rendered, and the DOM is touched only if
   the HTML changed.
3. The caret is restored by raw character offset, the block gets `.md-focus` (shows its `# ` / `- ` prefix) and every
   inline element touching the caret gets `.md-expand` (shows its `**` / `` ` `` / `[..](..)`).
4. Structural edits (Enter, merges, cross-block selections, paste, undo) are model operations, never browser ones.

Things that add pixels but no text never contribute characters, so the invariant holds: KaTeX formulas and diagram
previews (shadow DOM), images, task checkboxes, embeds and extension widgets (`[data-tm-ui]` mounts, skipped by the
source reader). Source mode is the same DOM with every `md-meta` span shown and previews hidden. `test/model.test.ts` checks it for every block and inline type.

## Develop

```bash
npm run dev        # demo at index.html
npm test           # vitest (jsdom)
npm run build      # dist/: typemark.js, style.css, *.d.ts
npm run pack:local # release/typemark-lite-<version>.tgz
```

Node: `^22.12 || >=24` (Vite 5).
