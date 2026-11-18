import { defineConfig } from "vite";

// One self-contained ES module for <script type="module"> / CDN use (artifacts, plain pages).
export default defineConfig({
  build: {
    lib: { entry: "src/standalone.ts", formats: ["es"], fileName: () => "typemark.standalone.js" },
    outDir: "dist",
    emptyOutDir: false,
    cssCodeSplit: false,
    sourcemap: false,
    minify: true,
  },
} as never);
