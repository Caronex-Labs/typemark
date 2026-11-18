import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: { entry: "src/index.ts", name: "TypeMark", fileName: "typemark", formats: ["es"] },
  },
  test: { environment: "jsdom" },
} as never);
