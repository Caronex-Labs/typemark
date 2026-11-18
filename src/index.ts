// KaTeX fonts must be registered in the document (shadow roots ignore @font-face);
// left as a bare import so the consuming bundler resolves the font files.
import "katex/dist/katex.min.css";
import "./style.css";

export { Editor, createEditor } from "./editor";
export type { EditorOptions, EditorState, Command, InlineFormat } from "./editor";
export { parse, serialize, renderBlock, blockType } from "./block";
export type { Block, BlockType } from "./block";
export { renderInline } from "./inline";
