---
title: Writing with typemark
tags: [markdown, engine, demo]
status: draft
---

# Writing with typemark

Everything here is **plain markdown**. Move the caret into *any* formatted text, a `code span` or a [link](https://example.com) and its syntax appears; move away and it disappears. There are no formatting buttons, because you never need them.

[toc]

## Type it, see it

- Start a line with `# `, `- `, `1. `, `> ` or `- [ ] `
- [ ] Press **Enter** to continue a list, Enter on an empty item to leave it
- [x] **Tab** / **Shift+Tab** to indent
- Type `/` at the start of a line for a menu that *types the syntax for you*

> [!tip] Callouts use the Obsidian syntax: `> [!tip]`, `> [!warning]`, `> [!danger]`, `> [!note]`…

> [!warning] Everything you see is stored as markdown. Toggle **Source** in the top bar to watch it.

## Media without buttons

Type `![](` and paste an image URL, or press **Enter** inside `![]()` to pick a file. You can also paste or drop images anywhere.

![Mountains](https://picsum.photos/id/1018/1200/500)

Embeds use `@[title](url)`: YouTube, Vimeo, Loom, CodePen, Figma, audio or video files.

@[Big Buck Bunny](https://www.youtube.com/watch?v=aqz-KE-bpKQ)

Diagrams are fenced `mermaid` blocks; click the diagram to edit it.

```mermaid
graph LR
  A[Type markdown] --> B{Caret nearby?}
  B -- yes --> C[Show syntax]
  B -- no --> D[Show rendered]
```

## Math, tables, code

Inline $e^{i\pi} + 1 = 0$, or a block:

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

| Syntax | Becomes | Notes |
|:--|:--:|--:|
| `![]()` + Enter | image picker | paste a URL instead |
| `@[](url)` | embed | sandboxed |
| `[toc]` | outline | live |

```ts
const editor = createEditor(el, { value, onChange });
```

## Your app decides what things do

Links to notes like [[Project ideas]] or [[Missing page]], tags like #inbox, and mentions like @sam are extensions: the host app supplies what happens on Cmd+click and what `[[`, `#` and `@` autocomplete with.

Buttons are widgets whose action is coded by the app:

```button
label: Insert timestamp
action: timestamp
```

---

Footnotes work too.[^1]

[^1]: Cmd+click a footnote marker to jump here.
