/**
 * Standalone browser build: katex + highlight.js bundled in, no bare imports.
 * Load KaTeX's stylesheet yourself (fonts):
 *   <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
 *   <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@caronex/typemark@VERSION/dist/style.css">
 *   <script type="module">import { createEditor } from "https://cdn.jsdelivr.net/npm/@caronex/typemark@VERSION/dist/typemark.standalone.js";</script>
 */
export * from "./api";
