import { defineConfig } from "vite";

// katex and highlight.js stay external so apps dedupe them and resolve KaTeX's fonts themselves.
// The one exception: the KaTeX stylesheet text injected into each formula's shadow root is
// bundled as a string (`?raw`, fonts stripped), so consumers don't need Vite-specific import support.
const external = (id: string) => !id.includes("?raw") && /^(katex|highlight\.js)(\/|$)/.test(id);

export default defineConfig({
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "typemark.js" },
    rollupOptions: { external },
    sourcemap: true,
    emptyOutDir: true,
  },
  test: { environment: "jsdom" },
} as never);
