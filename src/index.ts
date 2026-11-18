// KaTeX fonts must be registered in the document (shadow roots ignore @font-face);
// left as a bare import so the consuming bundler resolves the font files.
import "katex/dist/katex.min.css";
import "./style.css";

export { Editor, createEditor } from "./editor";
export type { EditorOptions, EditorState, Command, InlineFormat } from "./editor";
export { parse, serialize, renderBlock, blockType } from "./block";
export type { Block, BlockType } from "./block";
export { renderInline } from "./inline";
export { registerFenceRenderer, mermaidRenderer } from "./preview";
export type { FenceRenderer } from "./preview";
export { embedHtmlFor, defaultEmbedPolicy, fileToDataUrl } from "./media";
export type { EmbedPolicy } from "./media";
export { registerExtension, unregisterExtension } from "./extension";
export type {
  Extension,
  InlineExtension,
  InlinePart,
  BlockExtension,
  PrefixBlockExtension,
  WidgetBlockExtension,
  WidgetContext,
  Suggester,
  SuggestItem,
} from "./extension";
export {
  coreExtensions,
  embedExtension,
  tocExtension,
  calloutExtension,
  instructionExtension,
  slashMenu,
  wikilinks,
  tags,
  mentions,
  actionButtons,
} from "./extensions";
export type { LinkerOptions, ButtonSpec } from "./extensions";
export { AIReview, createReview, diffWords, mapOffset, renderMarkdown } from "./ai";
export type { Unit, Thread, ThreadEvent, ThreadEventType, InstructionJob, AIReviewOptions, Suggestion, SuggestionHandle, SuggestionDisplay, Note, NoteKind, NoteAction, Comment, Mark, MarkSeverity } from "./ai";
export type { DocChange } from "./editor";
export { extractMetadata, buildBacklinks } from "./metadata";
export type { DocumentMetadata, Backlink, Located } from "./metadata";
