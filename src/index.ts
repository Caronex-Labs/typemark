// KaTeX fonts must be registered in the document (shadow roots ignore @font-face);
// left as a bare import so the consuming bundler resolves the font files.
import "katex/dist/katex.min.css";

export * from "./api";
